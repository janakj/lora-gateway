import debug from 'debug';
import express from 'express';
import fetch from 'node-fetch';
import { UnauthorizedError, NotFoundError, jsonify, BadRequestError } from '@janakj/lib/http';
import { decrypt } from './lora';
import Database from './db';
import Message from './message';
import { Arguments } from './args';

const dbg = debug('lora:cra');

const EUI_REGEX = /[0-9A-F]{16}/,
    API_BASE = 'https://api.iot.cra.cz/cxf/IOTServices/v2';

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
        typeof arg.bat === 'number' && arg.bat > 0 && arg.bat <= 255;

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
    username   : string;
    password   : string;
    tenantId   : string;
    sessionId? : string;

    constructor(username: string, password: string, tenantId: string) {
        this.username = username;
        this.password = password;
        this.tenantId = tenantId;
    }

    async postJSON(path: string, body: any) {
        const headers: any = { 'Content-Type': 'application/json' };
        if (this.sessionId) headers.sessionId = this.sessionId;

        const res = await fetch(`${API_BASE}/${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const error: any = new Error(res.statusText);
            error.code = res.status;
            throw error;
        }

        const data = await res.json() as any;
        if (typeof data !== 'object' || typeof data.code !== 'number')
            throw new Error(`Got invalid response from the API endpoint ${path}`);

        if (data.code < 200 || data.code > 299)
            throw new Error(`API request failed: ${data.message}`);

        return data;
    }

    async login() {
        delete this.sessionId;

        const res = await this.postJSON('Login', {
            username: this.username,
            password: this.password
        });

        if (typeof res.sessionId !== 'string')
            throw new Error(`Invalid response from the Login API`);

        this.sessionId = res.sessionId;
    }

    async postJSONAuth(path: string, body: any) {
        let res;

        try {
            res = await this.postJSON(path, body);
        } catch (error: any) {
            if (error.code !== 401) throw error;
            await this.login();
            res = await this.postJSON(path, body);
        }

        return res;
    }

    async getMessages(since?: Date | string | number, until?: Date | string | number): Promise<object[]> {
        let dateFrom, dateTo;

        if (typeof since !== 'undefined') dateFrom = new Date(since).toISOString();
        if (typeof until !== 'undefined') dateTo = new Date(until).toISOString();

        const res = await this.postJSONAuth('MessageStoreQuery', {
            sync: true,
            criteria: {
                tenantId: this.tenantId,
                ...(dateFrom && { dateFrom }),
                ...(dateTo && { dateTo })
            }
        });
        return (res.data || []).map((msg: string) => JSON.parse(msg));
    }
}


class Puller {
    api      : API;
    interval : number;
    callback : (msg: any) => Promise<any>;
    db       : Database;

    constructor(api: API, db: Database, interval: number, callback: (msg: CraMessage) => Promise<void>) {
        this.api = api;
        this.interval = interval;
        this.callback = callback;
        this.db = db;

        this.fetch = this.fetch.bind(this);
        void this.fetch();
    }

    async fetch() {
        const now = new Date();

        const value = this.db.get('timestamp');
        const timestamp = value ? new Date(value) : undefined;

        try {
            const lst = await this.api.getMessages(timestamp, now);
            if (lst) dbg(`Fetched ${lst.length} message(s) from the network cra.cz`);
            try {
                await Promise.all(lst.map(m => this.callback(m)));
                // Update the timestamp of the most recently fetched message only after
                // we have successfully submitted all of them.
                this.db.set('timestamp', now.toISOString());
            } catch (error: any) {
                err(`Error while processing messages: ${error.message}\n`);
            }
        } catch (error: any) {
            err(`Error while fetching messages from cra.cz: ${error.message}\n`);
        }
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        setTimeout(this.fetch, this.interval);
    }
}


export default function (args: Arguments, db: Database, onMessage: (msg: Message) => void | Promise<void>) {
    const netId = 'cra.cz';

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
            throw new Error('Missing payload');
        }

        // Submit the message to upper layers. Construct a unique message id from
        // the string that uniquely identifies the network, the sequence number and
        // timestamp assigned to the message by the network server.
        await onMessage({
            id        : `${netId}:${src.ts}:${src.seqno}`,
            eui       : src.EUI,
            timestamp : new Date(src.ts).toISOString(),
            received  : new Date().toISOString(),
            data      : data.toString('base64'),
            origin    : JSON.parse(JSON.stringify(src)),
            encrypted
        } as Message);
    }

    const network = (args.networks as any || {})[netId];

    const { interval, username, password, tenantId } = network.pull || {};
    if (username && password && tenantId) {
        dbg(`Starting message puller for network ${netId} as user ${username}`);
        new Puller(new API(username, password, tenantId), db, (interval || 60) * 1000, processMessage);
    } else {
        dbg(`NOT starting message puller for network ${netId} (missing credentials)`);
    }

    const api = express.Router();
    api.use(express.json());

    const { authorization } = network.push || {};

    api.post('/', jsonify(async ({ body, headers }, res) => {
        if (authorization) {
            const v = (headers.authorization || '').trim();
            if (v !== authorization) throw new UnauthorizedError('Missing Authorization header');
        }

        dbg(`Message body: ${JSON.stringify(body)}`);

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
