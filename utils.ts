import { EventEmitter } from 'events';


export function abort(error, signame = 'SIGTERM') {
    if (typeof error !== 'undefined')
        // eslint-disable-next-line no-console
        console.error('Aborting: ', error);
    process.kill(process.pid, signame);
}


export function checkInt(val, min?: number, max?: number) {
    // eslint-disable-next-line no-param-reassign
    val = parseInt(val, 10);
    if (Number.isNaN(val))
        throw new Error(`Cannot convert '${val}' to integer`);

    if (typeof min !== 'undefined') {
        if (val < min)
            throw new Error(`Value ${val} must be >= than ${min}`);
    }

    if (typeof max !== 'undefined') {
        if (val > max)
            throw new Error(`Value ${val} must be <= than ${max}`);
    }

    return val;
}


export class HttpError extends Error {
    http_code: any;
    http_reason: any;
    constructor(message, code, reason) {
        super(message);
        this.http_code = code;
        this.http_reason = reason;
    }
}

export class ServerError extends HttpError {
    constructor(message, reason = 'Server Error', code = 500) {
        super(message, code, reason);
    }
}

export class BadRequestError extends HttpError {
    constructor(message, reason = 'Bad Request', code = 400) {
        super(message, code, reason);
    }
}

export class UnauthorizedError extends HttpError {
    constructor(message, reason = 'Unauthorized', code = 401) {
        super(message, code, reason);
    }
}

export class NotFoundError extends HttpError {
    constructor(message, reason = 'Not Found', code = 404) {
        super(message, code, reason);
    }
}

export class ConflictError extends HttpError {
    constructor(message, reason = 'Conflict', code = 409) {
        super(message, code, reason);
    }
}


// eslint-disable-next-line no-undef
interface CustomGlobal extends NodeJS.Global {
    devMode: boolean;
}

declare const global: CustomGlobal;

export function jsonifyError(res, error) {
    const code = error.http_code || 500,
        reason = error.http_reason || 'Internal Server Error';
    res.statusMessage = reason;
    res.status(code);
    res.type('application/json')
    res.json({
        code,
        reason,
        message: error.message,
        ...(global.devMode && { stack: error.stack })
    });
}


export const jsonify = fn =>
    async (req, res, next) => {
        try {
            const rv = await fn(req, res, next);
            if (typeof rv !== 'undefined') res.json(rv);
        } catch (error) {
            try {
                jsonifyError(res, error)
            } catch (e) {
                // If we get an error here, it's most likely because jsonifyError
                // attempted to set headers after they have been sent by express. Not
                // much we can do about it other than notify the admin on the console.
                // eslint-disable-next-line no-console
                console.log(e);
            }
        }
    }


export function sleep(ms, ...args) {
    return new Promise(resolve => setTimeout(resolve, ms, ...args));
}


export class Lock {
    _locked: boolean;
    _emitter: EventEmitter;

    constructor() {
        this._locked = false;
        this._emitter = new EventEmitter();
    }

    acquire() {
        return new Promise(resolve => {
            if (!this._locked) {
                this._locked = true;
                resolve();
                return;
            }

            const try_acquire = () => {
                if (!this._locked) {
                    this._locked = true;
                    this._emitter.removeListener('release', try_acquire);
                    resolve();
                }
            };

            this._emitter.on('release', try_acquire);
        });
    }

    release() {
        this._locked = false;
        setImmediate(() => this._emitter.emit('release'));
    }
}
