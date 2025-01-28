import http, { createServer as createHTTPServer } from 'http';
import debug from 'debug';
import morgan from 'morgan';
import { AddressInfo } from 'net';
import express from 'express';
import { chmodSync, promises as fs } from 'fs';

import abort from '@janakj/lib/abort';
import sleep from '@janakj/lib/sleep';
import loadArguments from './args.js';
import craApi from './cra.js';
import ttnApi from './ttn.js';
import Database from './db.js';
import Message from './message.js';
import { AsyncMqttClient } from 'async-mqtt';


const dbg = debug('lora:main');
const devMode = process.env.NODE_ENV === "development";

const log = (msg: string) => process.stdout.write(msg);


async function startListening(server: http.Server , sockAddr: any): Promise<AddressInfo | string> {
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
        process.setgroups!([gid]);
        process.setgid!(gid);
        process.setegid!(gid);
        log('done.\n');
    }

    if (uid) {
        log(`Switching to ${uid}...`);
        process.setuid!(uid);
        process.seteuid!(uid);
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

    async push(msg: Message) {
        if (await this.db.isSeen(msg.id)) return;
        await this.db.setSeen(msg.id);

        await this.db.enqueue(msg);
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
            await Promise.all((await this.db.getMessages()).map(async msg => {
                if (this.sink) {
                    await this.sink(msg);
                    await this.db.dequeue(msg);
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
    const db = Database.create(args.db);
    const queueMgr = new QueueManager(db);

    let mqttClient: AsyncMqttClient;
    if (args.mqtt_broker) {
        log(`Connecting to the MQTT broker at ${args.mqtt_broker}...`);
        const mqtt = (await import('async-mqtt')).default;
        mqttClient = await mqtt.connectAsync(args.mqtt_broker);

        queueMgr.setSink(async (msg: Message) => {
            await mqttClient.publish(`lora/${msg.eui}/uplink`, JSON.stringify(msg));
        });
        log('done.\n');
    }

    const app = express();
    app.use(morgan(devMode ? 'dev' : 'combined'));

    let server: http.Server;
    log(`Setting up a HTTP server...`);
    server = createHTTPServer(app);
    log('done.\n');

    app.use('/cra.cz', craApi(args, db, queueMgr.push));
    app.use('/ttn', ttnApi(args, db, queueMgr.push));

    const addr = await startListening(server, args.listen);
    log(`HTTP server is listening on ${addrToString(addr)}\n`);

    if (args.user || args.group)
        dropPrivileges(args.user, args.group);

    log('Initialization complete.\n');
})().catch(abort);
