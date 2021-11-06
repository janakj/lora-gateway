import http, { createServer as createHTTPServer } from 'http';
import https from 'https';
import debug from 'debug';
import morgan from 'morgan';
import { dirname } from 'path';
import { AddressInfo } from 'net';
import express from 'express';
import { fileURLToPath } from 'url';
import { chmodSync, promises as fs } from 'fs';
import { fork } from 'child_process';

import abort from '@janakj/lib/abort';
import sleep from '@janakj/lib/sleep';
import loadArguments from './args';
import craApi from './cra';
import Database from './db';
import Message from './message';
import { AsyncMqttClient } from 'async-mqtt';


const dbg = debug('lora:main');
const devMode = process.env.NODE_ENV === "development";

const log = (msg: string) => process.stdout.write(msg);
const err = (msg: string) => process.stderr.write(msg);


async function createHTTPSServer(app: express.Application, crtFilename: string, keyFilename?: string) {
    const args: https.ServerOptions = {};

    debug(`Loading TLS server certificate from file '${crtFilename}'`);
    args.cert = await fs.readFile(crtFilename);

    if (keyFilename === undefined) {
        debug(`TLS private key filename not specified, trying to load the key from ${crtFilename}`);
        keyFilename = crtFilename;
    }

    debug(`Loading TLS private key from file '${keyFilename}'`);
    args.key = await fs.readFile(keyFilename);

    const server = https.createServer(args, app);
    const { context } = (server as any)._sharedCreds;

    // If we drop privileges later, we will most likely lose access to the TLS
    // certificate and key files. Spawn a helper child process that will keep
    // running under current user (before dropping privileges) and that will
    // re-read the files for us whenever they change.

    const dir = dirname(fileURLToPath(import.meta.url));
    const watcher = fork(`${dir}/watcher.js`, [crtFilename, keyFilename], { cwd: '/' });
    watcher.on('disconnect', abort);
    watcher.on('message', ({ filename, data }: any) => {
        if (data === null) return;
        dbg(`Reloading TLS credentials from '${filename}'`);

        try {
            const contents = Buffer.from(data, 'base64');
            if (filename === crtFilename) context.setCert(contents);
            if (filename === keyFilename) context.setKey(contents);
        } catch (error: any) {
            err(`Failed to reload TLS credentials: ${error.message}\n`);
        }
    });

    return server;
}


async function startListening(server: http.Server | https.Server, sockAddr: any): Promise<AddressInfo | string> {
    if (typeof sockAddr === 'string') {
        try {
            await fs.stat(sockAddr);
            await fs.unlink(sockAddr);
        } catch (e) { /* empty */ }
    }

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        const args: any = {};

        if (typeof sockAddr === 'string') {
            args.path = sockAddr;
        } else {
            args.port = sockAddr.port;
            if (sockAddr.address) args.host = sockAddr.address;
        }

        server.listen(args, () => {
            const a = server.address();
            if (a === null) {
                reject(new Error('The server has been closed'));
            } else {
                try {
                    if (typeof sockAddr === 'string') chmodSync(sockAddr, '666');
                    resolve(a);
                } catch (e) {
                    reject(e);
                }
            }
        });
    });
}


function addrToString(addr: string | AddressInfo) {
    if (typeof addr === 'string') return `unix:${addr}`;
    if (addr.family === 'IPv6') return `tcp:[${addr.address}]:${addr.port}`;
    return `tcp:${addr.address}:${addr.port}`;
}


function dropPrivileges(uid?: number, gid?: number) {
    log(`Changing working directory to /...`);
    process.chdir('/');
    log('done.\n');

    if (gid) {
        log(`Switching to gid ${gid}...`);
        process.setgroups([gid]);
        process.setgid(gid);
        process.setegid(gid);
        log('done.\n');
    }

    if (uid) {
        log(`Switching to ${uid}...`);
        process.setuid(uid);
        process.seteuid(uid);
        log('done.\n');
    }
}


class QueueManager {
    db: Database;
    sink?: (msg: Message) => Promise<void> | void;
    running: Promise<void>;

    constructor(db: Database) {
        this.db = db;
        this.push = this.push.bind(this);
        this._flush = this._flush.bind(this);
        this.running = Promise.resolve();
    }

    push(msg: Message) {
        if (this.db.isSeen(msg.id)) return;
        this.db.setSeen(msg.id);

        this.db.enqueue(msg);
        this.flush();
    }

    setSink(f: (msg: Message) => Promise<void> | void) {
        this.sink = f;
        this.flush();
    }

    flush() {
        this.running = this.running.then(this._flush);
    }

    async _flush() {
        if (this.sink === undefined) return;

        try {
            await Promise.all(this.db.getMessages().map(async msg => {
                if (this.sink) {
                    await this.sink(msg);
                    this.db.dequeue(msg);
                }
            }));
        } catch (error) {
            await sleep(5);
            this.flush();
        }
    }
}


(async () => {
    log(`Starting in ${devMode ? 'development' : 'production'} mode\n`);
    const args = await loadArguments();
    const db = new Database(args.db);
    const queueMgr = new QueueManager(db);

    let mqttClient: AsyncMqttClient;
    if (args.mqtt_broker) {
        log(`Connecting to the MQTT broker at ${args.mqtt_broker}...`);
        const mqtt = (await import('async-mqtt')).default;
        mqttClient = await mqtt.connectAsync(args.mqtt_broker);

        queueMgr.setSink(async (msg: Message) => {
            await mqttClient.publish(`LoRa/${msg.eui}/message`, JSON.stringify(msg));
        });
        log('done.\n');
    }

    const app = express();
    app.use(morgan(devMode ? 'dev' : 'combined'));

    let server: http.Server | https.Server;
    if (args.tls_cert) {
        server = await createHTTPSServer(app, args.tls_cert, args.tls_key);
    } else {
        log(`Setting up a HTTP server...`);
        server = createHTTPServer(app);
        log('done.\n');
    }

    app.use('/cra.cz', craApi(args, db, queueMgr.push));

    const addr = await startListening(server, args.listen);
    log(`HTTP${args.tls_cert ? 'S' : ''} server is listening on ${addrToString(addr)}\n`);

    if (args.user || args.group)
        dropPrivileges(args.user, args.group);

    log('Initialization complete.\n');
})().catch(abort);
