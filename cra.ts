import debug from 'debug';
import express from 'express';
import fetch from 'node-fetch';
import { UnauthorizedError, NotFoundError, jsonify, BadRequestError } from '@janakj/lib/http';
import { decrypt } from './lora';
import Database from './db';
import Message from './message';
import { Arguments, NetworkConfig, CraNetworkConfig, isCraNetworkConfig } from './args';

const type = 'cra.cz';
const dbg = debug('lora:cra.cz');

const EUI_REGEX = /[0-9A-F]{16}/,
    API_BASE = 'https://api.iot.cra.cz/cxf/api/v1',
    TOKEN_URL = 'https://sso.cra.cz/auth/realms/CRA/protocol/openid-connect/token',
    CLIENT_ID = 'iot-api-client',
    CLIENT_SECRET = '41a113b7-5486-45e3-8a3d-e0b106a5d446',
    FROM_EPOCH = '2020';


const err = (msg: string) => process.stderr.write(msg);

interface Envelope {
    type : string;
    data : string;
    tech : string;
}

interface Gateway {
    rssi  : number;
    tmms  : number;
    snr   : number;
    ts    : number;
    time  : string;
    gweui : string;
    ant   : number;
    lat   : number;
    lon   : number;
}

interface CraMessage {
    cmd      : string;
    seqno    : number;
    EUI      : string;
    ts       : number;
    fcnt     : number;
    port     : number;
    freq     : number;
    toa      : number;
    dr       : string;
    ack      : boolean;
    gws      : Gateway[];
    bat      : number;
    data?    : string;
    encdata? : string;
}


function isCraMessage(arg: any): arg is CraMessage {
    const rv = arg.cmd === "gw" &&
        typeof arg.seqno === 'number' &&
        typeof arg.EUI === 'string' && arg.EUI.match(EUI_REGEX) &&
        typeof arg.ts === 'number' &&
        typeof arg.fcnt === 'number' &&
        typeof arg.port === 'number' &&
        typeof arg.freq === 'number' &&
        typeof arg.toa === 'number' &&
        typeof arg.dr === 'string' &&
        typeof arg.ack === 'boolean' &&
        Array.isArray(arg.gws) && arg.gws.length >= 1 &&
        typeof arg.bat === 'number';

    if (!rv) return false;

    if (typeof arg.data === 'undefined') {
        if (typeof arg.encdata !== 'string') return false;
        if (!arg.encdata.match(/[0-9A-F]*/)) return false;
    }

    if (typeof arg.data === 'string') {
        if (typeof arg.encdata !== 'undefined') return false;
        if (!arg.data.match(/[0-9A-F]*/)) return false;
    }

    return true;
}


function isPing(arg: any) {
    return arg.cmd === 'rx' && arg.EUI === 'PING';
}


function isEnvelope(arg: any): arg is Envelope {
    return arg.type === "D" &&
        typeof arg.data === "string" &&
        arg.tech === "L";
}


class API {
    username     : string;
    password     : string;
    accessToken? : string;

    constructor(username: string, password: string) {
        this.username = username;
        this.password = password;
    }

    async requestJSON(path: string, method: string, body?: string, headers: object = {}) {
        const hdr: any = {...headers};
        if (this.accessToken) hdr.Authorization = `Bearer ${this.accessToken}`;

        const req: any = { method, headers: hdr };
        if (body !== undefined) req.body = body;
        const res = await fetch(`${API_BASE}/${path}`, req);

        if (!res.ok) {
            let msg;
            try {
                msg = `${(await res.json() as any).errors}`;
            } catch (error: any ) {
                msg = res.statusText;
            }

            const error: any = new Error(msg);
            error.code = res.status;
        
            throw error;
        }

        const data = await res.json() as any;
        if (typeof data !== 'object')
            throw new Error(`Got invalid response from the API endpoint ${path}`);

        if (data.status !== "success")
            throw new Error(`API error ${data.code}: ${data.errors}`);

        return data;
    }

    async getAccessToken() {
        delete this.accessToken;

        dbg(`Obtaining access token for ${this.username}`);
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                username      : this.username,
                password      : this.password,
                grant_type    : 'password',
                client_id     : CLIENT_ID,
                client_secret : CLIENT_SECRET
            })
        });

        if (!res.ok) {
            const error: any = new Error(res.statusText);
            error.code = res.status;
            throw error;
        }

        const data = await res.json() as any;
        if (typeof data !== 'object' || typeof data.access_token !== 'string')
            throw new Error(`Got invalid access token response`);

        this.accessToken = data.access_token;
    }

    async requestJSONAuth(path: string, method: string, body?: string, headers: object = {}) {
        let res;

        try {
            res = await this.requestJSON(path, method, body, headers);
        } catch (error: any) {
            if (error.code !== 401) throw error;
            await this.getAccessToken();
            res = await this.requestJSON(path, method, body, headers);
        }

        return res;
    }

    async getDevices(): Promise<object[]> {
        const res = await this.requestJSONAuth('lora/devices', 'GET');
        return res.data || [];
    }

    async getMessages(device: string, from: Date | string | number, to: Date | string | number): Promise<object[]> {
        /* The new CRA API has a couple of peculiarities:
         * 1) It requires from and to timestamps, they are no longer optional;
         * 2) The two timestamps must be less than 31 days apart;
         * 3) It can send at most 1000 meessages at once.
         *
         * This makes the implementation of this function a bit more
         * complicated. We need to iterate over the time range in 30-day
         * increments and we need to download messages in 1000-message chunks.
         */
        let messages: object[] = [];
        const message_limit = 1000;
        const day_limit = 30;

        const params = new URLSearchParams();
        params.set('limit', `${message_limit}`);
        from = new Date(from);
        to = new Date(to);

        let deadline = new Date(from);
        for(;;) {
            deadline.setDate(deadline.getDate() + day_limit);
            if (deadline > to) deadline = to;

            params.set('from', from.toISOString());
            params.set('to', deadline.toISOString());
            dbg(`${from.toISOString()} ${deadline.toISOString()} ${to.toISOString()}`);

            let offset = 0;
            for(;;) {
                params.set('offset', `${offset}`);
                const res = await this.requestJSONAuth(`lora/devices/${device}/up/messages?${params}`, 'GET');
                if (!Array.isArray(res.data)) break;
                messages = messages.concat(res.data.map((m: any) => m.message));
                if (res.data.length < message_limit) break;
                offset += res.data.length;
            }

            if (deadline >= to) break;
            from = new Date(deadline);
            from.setMilliseconds(from.getMilliseconds() + 1);
        }
        return messages;
    }
}


class Puller {
    name     : string;
    api      : API;
    interval : number;
    callback : (msg: any) => Promise<any>;
    db       : Database;
    dbg      : (msg: string) => void;
    err      : (msg: string) => void;

    constructor(name: string, api: API, db: Database, interval: number, callback: (msg: CraMessage) => Promise<void>) {
        this.name = name;
        this.api = api;
        this.interval = interval;
        this.callback = callback;
        this.db = db;
        this.dbg = dbg.extend(name);
        this.err = msg => err(`${name}: ${msg}`);

        this.fetch = this.fetch.bind(this);
        void this.fetch();
    }

    async fetch() {
        const now = new Date();
        const timestamp = await this.db.get('timestamp');
        const since = new Date(timestamp !== undefined ? timestamp : FROM_EPOCH);

        try {
            this.dbg(`Listing LoRa devices for ${this.api.username}`);
            const devices: string[] = (await this.api.getDevices()).map((d: any) => d.deviceId);

            let current = '<none>';
            try {
                for(const device of devices) {
                    current = device;
                    this.dbg(`Fetching messages between ${since.toISOString()} and ${now.toISOString()} from device ${device}`);
                    const lst = await this.api.getMessages(device, since, now);    
                    if (lst) this.dbg(`Fetched ${lst.length} message(s)`);
                    await Promise.all(lst.map(m => this.callback(m)));
                }
                // Update the timestamp of the most recently fetched message only after
                // we have successfully submitted all of them.
                await this.db.set('timestamp', now.toISOString());
            } catch (error: any) {
                this.err(`Error while processing messages from device ${current}: ${error.message}\n`);
            }
        } catch (error: any) {
            this.err(`Error while fetching messages: ${error.message}\n`);
        }
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        setTimeout(this.fetch, this.interval);
    }
}


export default function (args: Arguments, db: Database, onMessage: (msg: Message) => void | Promise<void>) {
    async function processMessage(src: CraMessage) {
        let data, encrypted;

        if (!src.data && src.encdata) {
            // If we get an encrypted payload, attempt to decrypt. If
            // description fails, e.g., due to missing credentials, pass the
            // encrypted payload to upper layers unmodified, but set the
            // "encrypted" attribute on the resulting message.
            const ciphertext = Buffer.from(src.encdata, 'hex');

            const { appskey, devaddr } = (args.credentials as any || {})[src.EUI] || {};
            if (appskey && devaddr) {
                data = decrypt(ciphertext, devaddr, appskey, src.fcnt);
                encrypted = false;
            } else {
                data = ciphertext;
                encrypted = true;
            }
        } else if (src.data) {
            // Payload was not encrypted. Decode it into a Buffer from the hex
            // representation.
            data = Buffer.from(src.data, 'hex');
            encrypted = false;
        } else {
            throw new Error(`Missing payload in seqno ${src.seqno} from EUI ${src.EUI}`);
        }

        // Submit the message to upper layers. Construct a unique message id from
        // the string that uniquely identifies the network, the sequence number and
        // timestamp assigned to the message by the network server.
        await onMessage({
            id        : `${type}:${src.ts}:${src.seqno}`,
            eui       : src.EUI,
            timestamp : new Date(src.ts).toISOString(),
            received  : new Date().toISOString(),
            data      : data.toString('base64'),
            origin    : JSON.parse(JSON.stringify(src)),
            encrypted
        } as Message);
    }

    const networks: Record<string, CraNetworkConfig> = JSON.parse(JSON.stringify(args.networks));
    Object.entries<NetworkConfig>(networks).forEach(([name, value]) => {
        if (!isCraNetworkConfig(value)) delete networks[name];
    });

    const pullers: Puller[] = [];

    for(const [name, network] of Object.entries(networks)) {
        const { interval, username, password } = network.pull || {};
        if (username && password) {
            dbg(`Starting message puller for network ${type}:${name} as user ${username}`);
            pullers.push(new Puller(name, new API(username, password), db, (interval || 60) * 1000, processMessage));
        } else {
            dbg(`NOT starting message puller for network ${type}:${name} (missing credentials)`);
        }
    }

    const api = express.Router();
    api.use(express.json());

    api.post('/:name', jsonify(async ({ body, headers, params }, res) => {
        const network = networks[params.name];
        if (network === undefined)
            throw new NotFoundError(`Unknown network name`);

        const { authorization } = network.push || {};

        if (authorization) {
            const v = (headers.authorization || '').trim();
            if (v !== authorization) throw new UnauthorizedError('Missing Authorization header');
        }

        const dbg_ = dbg.extend(params.name);

        dbg_(`Message body: ${JSON.stringify(body)}`);

        if (isPing(body)) {
            res.status(200).end();
            return;
        }

        if (!isEnvelope(body)) throw new BadRequestError('Invalid message envelope');

        let msg;
        try {
            msg = JSON.parse(body.data);
        } catch (error) {
            throw new BadRequestError("Invalid message representation (JSON expected)");
        }

        if (typeof msg !== 'object' || !isCraMessage(msg))
            throw new BadRequestError('Invalid message format');

        await processMessage(msg);
        res.status(200).end();
    }));

    api.get('*', jsonify(() => {
        throw new NotFoundError("Not Found");
    }));

    return api;
}
