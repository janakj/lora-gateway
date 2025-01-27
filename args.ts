import debug from 'debug';
import userid from 'userid';
import parseCmdlineArgs from 'command-line-args';
import { promises as fs } from 'fs';
import { parseNumber } from '@janakj/lib/parse';

const dbg = debug('lora:args');


export interface SockAddr {
    port     : number;
    address? : string;
}


export interface Arguments {
    mqtt_broker? : string;
    config?      : string;
    db           : string;
    group?       : number;
    listen       : string | SockAddr;
    credentials? : Record<string, any>;
    networks     : Record<string, any>;
    user?        : number;
}


export interface NetworkConfig {
    type: string;
}


export interface CraNetworkConfig extends NetworkConfig {
    type: 'cra.cz',
    push?: {
        authorization: string
    },
    pull?: {
        interval?: number;
        username: string;
        password: string;
        tenantId: string;
    }
}


export interface TtnNetworkConfig extends NetworkConfig {
    type: 'ttn',
    push?: {
        authorization: string
    }
}


export function isCraNetworkConfig(value: NetworkConfig): value is CraNetworkConfig {
    return value.type === 'cra.cz';
}


export function isTtnNetworkConfig(value: NetworkConfig): value is TtnNetworkConfig {
    return value.type === 'ttn';
}


const defaults = {
    config : '/usr/local/etc/lora-gateway.json',
    db     : 'sqlite:/var/local/lora-gateway/state.db'
};


const cmdlineArgs = [
    { name : 'mqtt_broker', alias : 'b' },
    { name : 'config',      alias : 'c' },
    { name : 'db',          alias : 'd' },
    { name : 'group',       alias : 'g' },
    { name : 'listen',      alias : 'l' },
    { name : 'networks',    alias : 'n' },
    { name : 'credentials', alias : 'r' },
    { name : 'user',        alias : 'u' }
];


function parseListenString(val: string) {
    // UNIX domain socket pathname
    if (val.startsWith('/')) return val;

    let address, port, next = 0;

    if (val.startsWith('[')) {
        const end = val.indexOf(']');
        if (end === -1) throw new Error('Missing closing ] in listen argument value');
        address = val.slice(1, end);
        next = end + 1;
    }

    const d = val.indexOf(':', next);
    if (d === -1) {
        port = val;
    } else {
        address = address || val.slice(0, d);
        port = val.slice(d + 1);
    }

    if (port.toLowerCase() === 'random') port = 0;

    try {
        port = parseNumber(port, 0, 65535);
        const rv: any = { port };
        if (address) rv.address = address;
        return rv;
    } catch (e: any) {
        throw new Error(`Invalid port number: ${e.message}`);
    }
}


async function loadConfig(filename: string) {
    dbg(`Loading configuration file '${filename}'`);
    try {
        const rv = JSON.parse(await fs.readFile(filename, 'utf-8'));
        dbg(`Configuration file '${filename}' loaded`);
        return rv;
    } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        dbg(`Configuration file '${filename}' does not exist, skipping.`);
        return {};
    }
}


function loadEnvironment() {
    const rv: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
        if (typeof value === 'string') rv[name.toLowerCase()] = value;

    return rv;
}


function parseCredentials(cred: any) {
    if (cred === null)
        throw new Error("Missing 'credentials' parameter value");

    if (typeof cred === 'string') {
        try {
            // eslint-disable-next-line no-param-reassign
            cred = JSON.parse(cred);
        } catch (e) { /* empty */ }
    }

    if (cred !== undefined && typeof cred !== 'object')
        throw new Error("Invalid 'credentials' parameter format (JSON object expected)");

    return cred;
}


function parseUser(user: any) {
    if (user === null)
        throw new Error("Missing 'user' parameter value");

    if (user === undefined) return user;

    try {
        user = parseNumber(user, 0);
    } catch (error) {
        user = userid.uid(user);
    }

    return user;
}


function parseGroup(group: any) {
    if (group === null)
        throw new Error("Missing 'group' parameter value");

    if (group === undefined) return group;

    try {
        group = parseNumber(group, 0);
    } catch (error) {
        group = userid.gid(group);
    }

    return group;
}


export default async function loadArguments(): Promise<Arguments> {
    const cmdline = parseCmdlineArgs(cmdlineArgs);
    const env: any = loadEnvironment();

    const config = (cmdline || {}).config || env.config || defaults.config;
    if (typeof config !== 'string' && typeof config !== 'undefined')
        throw new Error(`Invalid 'config' parameter value ${config}`);

    const saved = config ? await loadConfig(config) : {};

    const args = { ...defaults, ...saved, ...env, ...cmdline };

    const names = cmdlineArgs.map(v => v.name);
    Object.keys(args).forEach(name => {
        if (names.indexOf(name) === -1) delete args[name];
    });

    if (args.mqtt_broker === null)
        throw new Error("Missing 'mqtt_broker' parameter value");

    if (args.db === null)
        throw new Error("Missing 'db' parameter value");

    if (typeof args.listen === 'string')
        args.listen = parseListenString(args.listen);

    if (args.listen === null)
        throw new Error("Missing 'listen' parameter value");

    if (typeof args.listen === 'undefined')
        args.listen = 80;

    args.credentials = parseCredentials(args.credentials);
    args.user = parseUser(args.user);
    args.group = parseGroup(args.group);

    if (args.networks === null)
        throw new Error("Missing 'networks' parameter value");

    if (typeof args.networks === 'string') {
        try {
            args.networks = JSON.parse(args.networks);
        } catch (e) { /* empty */ }
    }

    if (typeof args.networks !== 'object')
        throw new Error("Invalid or missing 'networks' parameter value");

    return args as Arguments;
}
