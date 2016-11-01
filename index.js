'use strict';

const format = require('util').format;
const util = require('silence-js-util');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const PAD_2_NUMS = util.formatDate.PAD_2_NUMS;

const LEVELS = {
  NONE: 6,
  ACCESS: 5,
  ERROR: 4,
  WARN: 3,
  INFO: 2,
  DEBUG: 1,
  TRACE: 0
};
const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'ACCESS', 'NONE'];
const MAX_CACHE_LENGTH = 10000; // 1万条可缓存在内存中, 当磁盘 IO 跟不上时。

function _err(err) {
  console.log(err.stack || err.message || err.toString());
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
    this.MAX_CACHE_LENGTH = cfg.maxCache || MAX_CACHE_LENGTH;
  }
  _putCache(msg) {
    if (this.cache.length > this.MAX_CACHE_LENGTH / 2 | 0) {
      _err(this.cache.length);
    }
    if (this.cache.length > this.MAX_CACHE_LENGTH) {
      _err(`FileLogger(level:${this.level}, section:${this.section}) cache received MAX_CACHE_LENGTH ${this.MAX_CACHE_LENGTH}`);
      _err(msg);
    } else {
      this.cache.push(msg);
    }
  }

  write(msg) {
    if (this.state === 1) {
      this._putCache(msg);
      return;
    }
    let d = new Date();
    if (this.y !== d.getFullYear() || this.m !== d.getMonth() || this.d !== d.getDate() || !this.stream) {
      if (this.stream) {
        this.stream.removeListener('error', this._errorHandler);
        this.stream.removeListener('drain', this._continueHandler);
        this.stream.end(); // just close previous stream
        this.stream = null;
      }
      this.y = d.getFullYear();
      this.m = d.getMonth();
      this.d = d.getDate();
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
      this.stream.removeAllListener('error', this._errorHandler);
      this.stream.removeAllListener('drain', this._continueHandler);
    }
    this.stream = null;
  }
  close() {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }
}

class FileLogger {
  constructor(config) {
    this._level = LEVELS[(config.level || 'ERROR').toUpperCase()];
    this._cluster = config.cluster ? `[${config.cluster.toUpperCase()}]` : '';
    this.path = path.resolve(process.cwd(), config.path || './data/logs');
    this.writers = new Map();
    this.commonWriters = new Array(LEVEL_NAMES.length);
    this._maxCache = config.maxCache || MAX_CACHE_LENGTH;
    this._maxAccessCache = config.maxAccessCache || this._maxCache;
    this._state = -1;  // -1: not init, 0: init and ready, 1: closed
    this.WriterClass = config.WriterClass || Writer;
  }
  get level() {
    return LEVEL_NAMES[this._level];
  }
  init() {
    if (this._state >= 0) {
      return Promise.resolve();
    }
    this._state = 0;
    LEVEL_NAMES.forEach((level, idx) => {
      let ws = new Map();
      this.writers.set(level, ws);
      let writer = new this.WriterClass({
        level,
        section: 'ALL',
        path: this.path,
        maxCache: level === 'ACCESS' ? this._maxAccessCache : this._maxCache
      });
      ws.set('ALL', writer);
      this.commonWriters[idx] = writer;
    });
    return util.mkdirP(this.path);
  }
  close() {
    if (this._state > 0) {
      return;
    }
    this._state = 1;
    LEVEL_NAMES.forEach((level, idx) => {
      let ws = this.writers.get(level);
      if (!ws) {
        return;
      }
      let it = ws.values();
      let n = it.next();
      while(!n.done && n.value) {
        n.value.close();
        n = it.next();
      }
      ws.clear();
    });
    this.writers.clear();
  }
  _format(level, ...args) {
    let prefix = this._cluster + `[${util.formatDate()}] `;
    return prefix + format(...args) + '\n'
  }
  debug(...args) {
    if (LEVELS.DEBUG < this._level) {
      return;
    }
    this._write(LEVELS.DEBUG, 'ALL', ...args);
  }
  error(...args) {
    if (LEVELS.ERROR < this._level) {
      return;
    }
    if (args.length === 1 && typeof args[0] === 'string') {
      this._write(LEVELS.ERROR, 'ALL', new Error(args[0]));
    } else {
      this._write(LEVELS.ERROR, 'ALL', ...args);
    }
  }
  info(...args) {
    if (LEVELS.INFO < this._level) {
      return;
    }
    this._write(LEVELS.INFO, 'ALL', ...args);
  }
  warn(...args) {
    if (LEVELS.WARN < this._level) {
      return;
    }
    this._write(LEVELS.WARN, 'ALL', ...args);
  }
  trace(...args) {
    if (LEVELS.TRACE < this._level) {
      return;
    }
    this._write(LEVELS.TRACE, 'ALL', ...args);
  }
  sdebug(section, ...args) {
    if (LEVELS.DEBUG < this._level) {
      return;
    }
    this._write(LEVELS.DEBUG, section, ...args);
  }
  serror(section, ...args) {
    if (LEVELS.ERROR < this._level) {
      return;
    }
    if (args.length === 1 && typeof args[0] === 'string') {
      this._write(LEVELS.ERROR, section, new Error(args[0]));
    } else {
      this._write(LEVELS.ERROR, section, ...args);
    }
  }
  sinfo(section, ...args) {
    if (LEVELS.INFO < this._level) {
      return;
    }
    this._write(LEVELS.INFO, section, ...args);
  }
  swarn(section, ...args) {
    if (LEVELS.WARN < this._level) {
      return;
    }
    this._write(LEVELS.WARN, section, ...args);
  }
  access(method, code, duration, bytesRead, bytesWritten, user, clientIp, remoteIp, userAgent, url) {
    if (LEVELS.ACCESS < this._level || this._state !== 0) {
      return;
    }
    let ds = duration < 2000 ? duration + 'ms' : (duration / 1000 | 0) + 's';
    if (userAgent && userAgent.indexOf('"') >= 0) {
      userAgent = userAgent.replace(/\"/g, '\\"')
    }
    this.commonWriters[LEVELS.ACCESS].write(this._cluster + `[${util.formatDate()}] [${code !== 0 && code < 1000 ? code : 200}] [${method}] [${ds}] [${bytesRead}] [${bytesWritten}] [${user ? user : '-'}] [${clientIp || '-'}] [${remoteIp || '-'}] "${userAgent || '-'}" ${url}\n`);
  }
  _write(level, section, ...args) {
    if (args.length === 0 || this._state !== 0) {
      return;
    }
    let writer;
    if (section === 'ALL') {
      writer = this.commonWriters[level];
    } else {
      let ws = this.writers.get(LEVEL_NAMES[level]);
      if (!ws.has(section)) {
        ws.set(section, new this.WriterClass({
          level: LEVEL_NAMES[level],
          section: section,
          path: this.path,
          maxCache: this._maxCache
        }));
      }
      writer = ws.get(section);
    }
    let msg = this._format(level, ...args);
    writer.write(msg);
  }
}

FileLogger.LEVELS = LEVELS;
FileLogger.LEVEL_NAMES = LEVEL_NAMES;
FileLogger.Writer = Writer;

module.exports = FileLogger;
