'use strict';

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
    this.MAX_CACHE_LENGTH = cfg.maxCache;
    this._cleanup = false;
    this._exitResolve = null;
    this._errorCount = 0;
    this._lastErrorTime = null;
    this._flCount = 0;
    this._wlCount = 0;
  }
  __collectStatus() {
    return {
      level: this.level,
      errorCount: this._errorCount,
      lastErrorTime: this._lastErrorTime,
      cacheSize: this.cache.length,
      fallbackCount: this._flCount,
      logCount: this._wlCount
    };
  }

  get isAvaliable() {
    return this.state === 0 || this.cache.length < this.MAX_CACHE_LENGTH;
  }

  write(msg) {
    if (this._cleanup) {
      return; // already closed
    }
    msg = msg.replace(/\n/g, '\\n') + '\n';

    if (this.state === 1) {
      this.cache.push(msg);
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
    this._wlCount++;
    if (!this.stream.write(msg)) {
      this.state = 1; // busy
    }
  }
  _continue() {
    while(this.cache.length > 0) {
      let msg = this.cache.splice(0, 256);
      this._wlCount += msg.length;
      if (!this.stream.write(msg.join(''))) {
        break;
      }
    }
    this.state = this.cache.length > 0 ? 1 : 0;
    if (this.state === 0 && this._cleanup && this._exitResolve) {
      this._closeStream(this._exitResolve);
      this._exitResolve = null;
    }
  }
  _error(err, level) {
    this._errorCount++;
    this._lastErrorTime = new Date();
    
    if (this._cleanup && this._exitResolve) {
      this._exitResolve();
      this._exitResolve = null;
    }
    _err(err);
    if (this.stream) {
      this.stream.removeListener('error', this._errorHandler);
      this.stream.removeListener('drain', this._continueHandler);
    }
    this.stream = null;
  }
  _closeStream(exitResolve) {
    var stream = this.stream;
    var _ended = false;
    function onEnd(err) {
      if (_ended) {
        return;
      }
      _ended = true;
      exitResolve();
      stream.removeListener('finish', onEnd);
      stream.removeListener('error', onEnd);
      if (this.fl !== null) {
        this.fl.serror('file-logger', err);
      } else {
        console.log(err);
      }
    }
    stream.removeListener('error', this._errorHandler);
    stream.removeListener('drain', this._continueHandler);
    stream.on('finish', onEnd);
    stream.on('error', onEnd);
    stream.end();
  }
  close() {
    if (this._cleanup) {
      return Promise.resolve();
    }
    this._cleanup = true;
    return new Promise(resolve => {
      if (this.cache.length > 0) {
        this._exitResolve = resolve;
      } else if (this.stream) {
        this._closeStream(resolve);
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
    this._TYPE = 'file';
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

  __collectStatus() {
    return {
      type: this._TYPE,
      writers: this._writers.map(w => w.__collectStatus()),
      swriters: this._swriters.map(ws => {
        let it = ws.entries();
        let n = it.next();
        let s = {};
        while(!n.done && n.value && n.value.length === 2) {
          s[n.value[0]] = n.value[1].__collectStatus();
          n = it.next();
        }
        return s;
      }),
      fallbackLogger: this.fl ? this.fl.__collectStatus() : null
    };
  }

  _createWriter(level, section = 'ALL') {
    return new Writer({
      level,
      section,
      path: this.path,
      maxCache: level === 'ACCESS' ? this._maxAccessCache : this._maxCache
    });
  }

  _init() {
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
    if (!this.path) {
      this._state = 0;
      return Promise.resolve();
    } else {
      return util.mkdirP(this.path).then(() => {
        this._state = 0;
      });
    }
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
  _format(level, args, ts) {
    let prefix = this._cluster + `[${util.formatDate(ts ? new Date(ts) : undefined)}] `;
    return prefix + (level === LEVELS.ERROR ? util.formatError(args) : util.formatArray(args));
  }
  debug(...args) {
    if (LEVELS.DEBUG < this._level || this._state > 0) {
      return;
    }
    this._write(LEVELS.DEBUG, args);
  }
  error(err) {
    if (LEVELS.ERROR < this._level || this._state > 0) {
      return;
    }
    this._write(LEVELS.ERROR, err);
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
  serror(section, err) {
    if (LEVELS.ERROR < this._level || this._state > 0) {
      return;
    }
    this._swrite(LEVELS.ERROR, section, err);
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
      this._ulCount++;
      // ignore
      // console.log(method, code, duration, bytesRead, bytesWritten, user, clientIp, remoteIp, userAgent, url);
    }
  }
  _write(level, args, ts) {
    if (this._state !== 0) {
      if (this.fl !== null) {
        this.fl._write(level, args, ts);
      } else {
        console.log(args);
      }
      return;
    }
    let wr = this._writers[level];
    if (wr.isAvaliable) {
      let msg = this._format(level, args, ts);
      wr.write(msg);
    } else if (this.fl !== null) {
      wr._flCount++;
      this.fl._write(level, args, ts);
    } else {
      console.log(args);
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
  _swrite(level, section, args, ts) {
    if (this._state !== 0) {
      if (this.fl !== null) {
        this.fl._swrite(level, section, args, ts);
      } else {
        console.log(args);
      }
      return;
    }
    let wr = this._getWriter(level, section);
    if (wr.isAvaliable) {
      wr.write(this._format(level, args, ts));
    } else if (this.fl !== null) {
      wr._flCount++;
      this.fl._swrite(level, section, args, ts);
    } else {
      console.log(args);
    }
  }
}

FileLogger.LEVELS = LEVELS;
FileLogger.LEVEL_NAMES = LEVEL_NAMES;
FileLogger.Writer = Writer;

module.exports = FileLogger;
