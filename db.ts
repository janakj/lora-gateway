import { readFileSync } from 'fs';
import { mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import Sqlite from 'better-sqlite3';
import Message from './message.js';
import debug from 'debug';
import pg from 'pg';

const dbg = debug('lora:db');


export default abstract class Database {
    abstract isSeen(id: string): boolean | Promise<boolean>;
    abstract setSeen(id: string): void | Promise<void>;

    abstract get(name: string): string | undefined | Promise<string | undefined>;
    abstract set(name: string, value?: string): void | Promise<void>;

    abstract enqueue(msg: Message): void | Promise<void>;
    abstract dequeue(msg: Message): void | Promise<void>;
    abstract getMessages(): Message[] | Promise<Message[]>;

    static create(url: string): Database {
        const sep = url.indexOf(':');
        if (sep === -1) throw new Error(`Mising database URL scheme`);

        const scheme = url.toLowerCase().slice(0, sep);
        const body = url.slice(sep + 1);

        switch(scheme) {
            case 'sqlite':     return new SQLiteDatabase(body);
            case 'postgresql': return new PostgresSQLDatabase(body);
            default:           throw new Error(`Unsupported database scheme ${scheme}`);
        }
    }
}


class PostgresSQLDatabase extends Database {
    pool?: pg.Pool;

    constructor(filename: string) {
        super();
        dbg(`Loading PostgreSQL credentials from ${filename}`);

        let credentials: Record<string, string> | undefined;
        try {
            const data = readFileSync(filename, 'utf-8');
            try {
                credentials = JSON.parse(data);
                if (typeof credentials !== 'object')
                    throw new Error('Database credentials must be an object');
            } catch(error) {
                throw new Error('Unsupported format of database credentials (JSON expected)');
            }
        } catch(error) {
            throw new Error(`Could not read file ${filename}: ${error}`);
        }

        this.pool = new pg.Pool({
            user     : credentials.user,
            host     : credentials.host,
            database : credentials.dbname,
            ssl: {
                rejectUnauthorized: true,
                ca   : credentials.sslrootcert,
                key  : credentials.sslkey,
                cert : credentials.sslcert,
            },
        });
    }

    private async withDB<T>(cb: (client: pg.PoolClient) => Promise<T>) {
        const client = await this.pool!.connect();
        try {
            return await cb(client);
        } finally {
            client.release();
        }
    }

    async isSeen(id: string) {
        return this.withDB(async (client) => {
            const { rowCount } = await client.query('select * from seen where id=$1', [ id ]);
            return rowCount !== 0;
        });
    }

    async setSeen(id: string) {
        return this.withDB(async (client) => {
            await client.query('insert into seen (id) values ($1)', [ id ]);
        });
    }

    async get(name: string) {
        return this.withDB(async (client) => {
            const { rows, rowCount } = await client.query('select value from attrs where name=$1', [ name ]);
            if (rowCount !== 1) return undefined;
            const { value } = rows[0];
            if (value === undefined || value === null) return undefined;
            return value as string;
        });
    }

    async set(name: string, value?: string) {
        return this.withDB(async (client) => {
            await client.query(`
                insert into attrs (name, value) values ($1, $2)
                on conflict (name) do update set value=$2`, [ name, value ]);
        });
    }

    async enqueue(msg: Message) {
        return this.withDB(async (client) => {
            await client.query('insert into queue (message_id, message) values ($1, $2::jsonb)',
                [ msg.id, msg ]);
        });
    }

    async dequeue(msg: Message) {
        return this.withDB(async (client) => {
            await client.query('delete from queue where message_id=$1', [ msg.id ]);
        });
    }

    async getMessages() {
        return this.withDB(async (client) => {
            const { rows } = await client.query('select message::jsonb from queue');
            return rows.map(row => row.message as Message);
        });
    }
}


class SQLiteDatabase extends Database {
    db          : Sqlite.Database;
    seenSelect  : Sqlite.Statement;
    seenInsert  : Sqlite.Statement;
    attrSelect  : Sqlite.Statement;
    attrReplace : Sqlite.Statement;
    queueInsert : Sqlite.Statement;
    queueDelete : Sqlite.Statement;
    queueSelect : Sqlite.Statement;

    constructor(filename: string) {
        super();
        dbg(`Opening SQLite database ${filename}`);

        // Create the directory for database files. Set the permissions to 1777
        // to make sure that we can create files in the directory after dropping
        // privileges (switching users). The directory will have the same
        // permissions as /tmp, i.e., everybody will be able to write, but only
        // the owner will be able to delete the files.
        const dir = dirname(filename);
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o1777);

        this.db = new Sqlite(filename);
        this.createTables();

        this.seenSelect = this.db.prepare('SELECT * FROM seen WHERE id=?');
        this.seenInsert = this.db.prepare('INSERT INTO seen (id) VALUES (?)');

        this.attrSelect = this.db.prepare('SELECT value FROM attrs WHERE name=?');
        this.attrReplace = this.db.prepare('REPLACE INTO attrs (name, value) VALUES (?, ?)');

        this.queueInsert = this.db.prepare('INSERT INTO queue (messageId, message) VALUES (?, ?)');
        this.queueDelete = this.db.prepare('DELETE FROM queue WHERE messageId=?');
        this.queueSelect = this.db.prepare('SELECT message FROM queue');
    }

    createTables() {
        this.db.exec("CREATE TABLE IF NOT EXISTS attrs (\n\
    name  TEXT NOT NULL,                                \n\
    value TEXT DEFAULT NULL);                           \n\
    CREATE UNIQUE INDEX IF NOT EXISTS attrIndex ON attrs(name);");

        this.db.exec("CREATE TABLE IF NOT EXISTS seen (\n\
    id TEXT NOT NULL);                                 \n\
    CREATE UNIQUE INDEX IF NOT EXISTS seenIndex ON seen(id);");

        this.db.exec("CREATE TABLE IF NOT EXISTS queue (\n\
    id        INTEGER PRIMARY KEY,                      \n\
    messageId TEXT NOT NULL,                            \n\
    message   TEXT NOT NULL);                           \n\
    CREATE UNIQUE INDEX IF NOT EXISTS queueIndex ON queue(messageId);");
    }

    isSeen(id: string) {
        return this.seenSelect.get(id) !== undefined;
    }

    setSeen(id: string) {
        this.seenInsert.run(id);
    }

    get(name: string) {
        const v: string | null | undefined = (this.attrSelect.get(name) || {} as any).value;
        return v === null ? undefined : v;
    }

    set(name: string, value?: string) {
        this.attrReplace.run(name, value === undefined ? null : value);
    }

    enqueue(msg: Message) {
        this.queueInsert.run(msg.id, JSON.stringify(msg));
    }

    dequeue(msg: Message) {
        this.queueDelete.run(msg.id);
    }

    getMessages() {
        return this.queueSelect.all().map(row => JSON.parse((row as any).message));
    }
}