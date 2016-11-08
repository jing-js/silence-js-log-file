'use strict';

const format = require('util').format;
const util = require('silence-js-util');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const PAD_2_NUMS = util.formatDate.PAD_2_NUMS;

const LEVELS = {
  NONE: 5,
  ACCESS: 4,
  ERROR: 3,
  WARN: 2,
  INFO: 1,
  DEBUG: 0,
};
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'ACCESS', 'NONE'];

function _err(err) {
  console.log(err);
}

class Writer {
  constructor(cfg) {
    this.y = -1;
    this.m = -1;
    this.d = -1;
    this.level = cfg.level.toUpperCase();
    this.section = cfg.section.toUpperCase();
    this.postfix = (this.section === 'ALL' ? '' : `.${this.section.toLowerCase()}`) + `.${cfg.level.toLowerCase()}`;
    this.path = cfg.path;
    this.state = 0;
    this.cache = [];
    this._continueHandler = this._continue.bind(this);
    this._errorHandler = this._error.bind(this);
    this.stream = null;
    this.fl = cfg.fl; // fallbackLogger
    this.MAX_CACHE_LENGTH = cfg.maxCache;
  }
  _putCache(msg) {
    // console.log(this.level, this.cache.length, this.MAX_CACHE_LENGTH)
    if (this.cache.length >= this.MAX_CACHE_LENGTH) {
      if (this.fl !== null) {
        this.fl.serror('file-logger', this.level, this.section, 'cache received MAX_CACHE_LENGTH', this.MAX_CACHE_LENGTH);
        this.fl._write(msg);
      } else {
        console.log('file-logger', this.level, this.section, 'cache received MAX_CACHE_LENGTH', this.MAX_CACHE_LENGTH);
        console.log(msg);
      }
    } else {
      this.cache.push(msg);
    }
  }

  get isAvaliable() {
    return this.state === 0 || this.cache.length < this.MAX_CACHE_LENGTH;
  }

  write(msg) {
    msg = msg.replace(/\n/g, '\\n') + '\n';

    if (this.state === 1) {
      this._putCache(msg);
      return;
    }
    let d = new Date();
    if (this.y !== d.getUTCFullYear() || this.m !== d.getUTCMonth() || this.d !== d.getUTCDate() || !this.stream) {
      if (this.stream) {
        this.stream.removeListener('error', this._errorHandler);
        this.stream.removeListener('drain', this._continueHandler);
        this.stream.end(); // just close previous stream
        this.stream = null;
      }
      this.y = d.getUTCFullYear();
      this.m = d.getUTCMonth();
      this.d = d.getUTCDate();
      let file = path.join(
        this.path,
        `${this.y}-${PAD_2_NUMS[this.m + 1]}-${PAD_2_NUMS[this.d]}${this.postfix}.log`
      );
      this.stream = fs.createWriteStream(file, {
        flags: 'a'
      });
      this.stream.on('drain', this._continueHandler);
      this.stream.on('error', this._errorHandler);
    }

    if (!this.stream.write(msg)) {
      this.state = 1; // busy
    }
  }
  _continue() {
    if (this.state !== 1) {
      return;
    }
    while(this.cache.length > 0) {
      let msg = this.cache.shift();
      if (!this.stream.write(msg)) {
        break;
      }
    }
    this.state = this.cache.length > 0 ? 1 : 0;
  }
  _error(err, level) {
    _err(err);
    if (this.stream) {
      this.stream.removeListener('error', this._errorHandler);
      this.stream.removeListener('drain', this._continueHandler);
    }
    this.stream = null;
  }
  close() {
    return new Promise((resolve, reject) => {
      if (this.stream) {
        this.stream.on('finish', resolve);
        this.stream.on('error', reject);
        this.stream.end();
        this.stream = null;
      } else {
        resolve();
      }
    });
  }
}

class FileLogger {
  constructor(config) {
    this._level = LEVELS[(config.level || 'ERROR').toUpperCase()];
    this._cluster = config.cluster > -2 ? `[${config.cluster === -1 ? 'MASTER' : 'W_' + config.cluster}] ` : '';
    this.path = path.resolve(process.cwd(), config.path || './data/logs');
    this._swriters = new Array(LEVEL_NAMES.length);
    this._writers = new Array(LEVEL_NAMES.length);
    this._accessWriter = null;
    this._maxCache = config.maxCache || MAX_CACHE_LENGTH;
    this._maxAccessCache = config.maxAccessCache || this._maxCache;
    this._state = -1;  // -1: not init, 0: init and ready, 1: closed,
    this.fl = config.fallbackLogger || null;
  }
  get level() {
    return LEVEL_NAMES[this._level];
  }
  
  get isReady() {
    return this._state === 0;
  }
  
  get isClosed() {
    return this._state > 0;
  }

  _createWriter(level, section = 'ALL') {
    return new Writer({
      level,
      section,
      path: this.path,
      maxCache: level === 'ACCESS' ? this._maxAccessCache : this._maxCache,
      fl: this.fl
    });
  }

  _init() {
    this._state = 0;
    LEVEL_NAMES.forEach((level, idx) => {
      if (level === 'NONE') {
        return;
      }
      let ws = new Map();
      this._swriters[idx] = ws;
      let writer = this._createWriter(level);
      this._writers[idx] = writer;
    });
    this._accessWriter = this._writers[LEVELS.ACCESS];
    return this.path ? util.mkdirP(this.path) : Promise.resolve();
  }
  init() {
    if (this._state >= 0) {
      return Promise.resolve();
    }
    if (this.fl) {
      return this.fl.init().then(() => {
        return this._init();
      });
    } else {
      return this._init();
    }
  }
  close() {
    if (this._state > 0) {
      return Promise.resolve();
    }
    this._state = 1;
    let arr = [];
    this._swriters.forEach(ws => {
      let it = ws.values();
      let n = it.next();
      while(!n.done && n.value) {
        arr.push(n.value.close());
        n = it.next();
      }
      ws.clear();
    });
    this._writers.forEach(writer => {
      arr.push(writer.close());
    });
    this._writers.length = 0;
    this._swriters.length = 0;

    if (this.fl) arr.push(this.fl.close());

    return Promise.all(arr);
  }
  _format(level, args) {
    let prefix = this._cluster + `[${util.formatDate()}] `;
    return prefix + format(...args);
  }
  debug(...args) {
    if (LEVELS.DEBUG < this._level || this._state > 0) {
      return;
    }
    this._write(LEVELS.DEBUG, args);
  }
  error(...args) {
    if (LEVELS.ERROR < this._level || this._state > 0) {
      return;
    }
    if (args.length === 1 && typeof args[0] === 'string') {
      this._write(LEVELS.ERROR, [new Error(args[0])]);
    } else {
      this._write(LEVELS.ERROR, args);
    }
  }
  info(...args) {
    if (LEVELS.INFO < this._level || this._state > 0) {
      return;
    }
    this._write(LEVELS.INFO, args);
  }
  warn(...args) {
    if (LEVELS.WARN < this._level || this._state > 0) {
      return;
    }
    this._write(LEVELS.WARN, args);
  }
  sdebug(section, ...args) {
    if (LEVELS.DEBUG < this._level || this._state > 0) {
      return;
    }
    this._swrite(LEVELS.DEBUG, section, args);
  }
  serror(section, ...args) {
    if (LEVELS.ERROR < this._level || this._state > 0) {
      return;
    }
    if (args.length === 1 && typeof args[0] === 'string') {
      this._swrite(LEVELS.ERROR, section, [new Error(args[0])]);
    } else {
      this._swrite(LEVELS.ERROR, section, args);
    }
  }
  sinfo(section, ...args) {
    if (LEVELS.INFO < this._level || this._state > 0) {
      return;
    }
    this._swrite(LEVELS.INFO, section, args);
  }
  swarn(section, ...args) {
    if (LEVELS.WARN < this._level || this._state > 0) {
      return;
    }
    this._swrite(LEVELS.WARN, section, args);
  }
  access(method, code, duration, bytesRead, bytesWritten, user, clientIp, remoteIp, userAgent, url) {
    if (LEVELS.ACCESS < this._level || this._state > 0) {
      return;
    }
    if (this._state === 0 && this._accessWriter.isAvaliable) {
      let ds = duration < 2000 ? duration + 'ms' : (duration / 1000 | 0) + 's';
      if (userAgent && userAgent.indexOf('"') >= 0) {
        userAgent = userAgent.replace(/\"/g, '\\"')
      }
      this._accessWriter.write(this._cluster + `[${util.formatDate()}] [${code !== 0 && code < 1000 ? code : 200}] [${method}] [${ds}] [${bytesRead}] [${bytesWritten}] [${user ? user : '-'}] [${clientIp || '-'}] [${remoteIp || '-'}] "${userAgent || '-'}" ${url}`);
    } else if (this.fl !== null) {
      this.fl.access(method, code, duration, bytesRead, bytesWritten, user, clientIp, remoteIp, userAgent, url);
    } else {
      console.log.apply(console, arguments);
    }
  }
  _write(level, args) {
    if (args.length === 0) {
      return;
    }
    if (this._state === 0 && this._writers[level].isAvaliable) {
      let msg = this._format(level, args);
      this._writers[level].write(msg);
    } else if (this.fl !== null) {
      this.fl._write(level, args);
    } else {
      console.log(...args);
    }
  }
  _getWriter(level, section) {
    let ws = this._swriters[level];
    let writer = ws.get(section);
    if (!writer) {
      writer = this._createWriter(LEVEL_NAMES[level], section);
      ws.set(section, writer);
    }
    return writer;
  }
  _swrite(level, section, args) {
    if (args.length === 0) {
      return;
    }
    let wr;
    if (this._state === 0 && (wr = this._getWriter(level, section)).isAvaliable) {
      wr.write(this._format(level, args));
    } else if (this.fl !== null) {
      this.fl._swrite(level, section, args);
    } else {
      console.log(...args);
    }
  }
}

FileLogger.LEVELS = LEVELS;
FileLogger.LEVEL_NAMES = LEVEL_NAMES;
FileLogger.Writer = Writer;

module.exports = FileLogger;
