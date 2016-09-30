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
  DEBUG: 0
};
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'ACCESS', 'NONE'];
const MAX_CACHE_LENGTH = 100000; // 10万条可缓存在内存中, 当磁盘 IO 跟不上时。

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
  }
  _putCache(msg) {
    this.cache.push(msg);
    if (this.cache.length > MAX_CACHE_LENGTH) {
      _err(`FileLogger(level:${this.level}, section:${this.section}) cache received MAX_CACHE_LENGTH ${MAX_CACHE_LENGTH}`);
      _err(this.cache.shift());
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
    this.level = LEVELS[(config.level || 'ERROR').toUpperCase()];
    this.path = path.resolve(process.cwd(), config.path || './data/logs');
    this.writers = new Map();
    this.commonWriters = new Array(LEVEL_NAMES.length);
  }
  init() {
    LEVEL_NAMES.forEach((level, idx) => {
      let ws = new Map();
      this.writers.set(level, ws);
      let writer = new Writer({
        level,
        section: 'ALL',
        path: this.path
      });
      ws.set('ALL', writer);
      this.commonWriters[idx] = writer;
    });
    return util.mkdirP(this.path);
  }
  close() {
    this.writers.values.forEach(ws => {
      ws.values.forEach(writer => {
        writer.close();
      });
    });
  }
  _log(level, section, ...args) {
    if (level < this.level) {
      return;
    }
    this._write(level, section.toLowerCase(), ...args);
  }
  _format(level, ...args) {
    let prefix = (cluster.isWorker ? `[${cluster.worker.id}] ` : '') + `[${util.formatDate()}] `;
    if (args.length === 1) {
      return prefix + (typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0].toString()) + '\n';
    } else {
      return prefix + format(...args) + '\n';
    }
  }
  debug(...args) {
    this._log(LEVELS.DEBUG, 'ALL', ...args);
  }
  error(...args) {
    this._log(LEVELS.ERROR, 'ALL', ...args);
  }
  info(...args) {
    this._log(LEVELS.INFO, 'ALL', ...args);
  }
  warn(...args) {
    this._log(LEVELS.WARN, 'ALL', ...args);
  }
  sdebug(section, ...args) {
    this._log(LEVELS.DEBUG, section, ...args);
  }
  serror(section, ...args) {
    this._log(LEVELS.ERROR, section, ...args);
  }
  sinfo(section, ...args) {
    this._log(LEVELS.INFO, section, ...args);
  }
  swarn(section, ...args) {
    this._log(LEVELS.WARN, section, ...args);
  }
  access(method, code, duration, bytesRead, bytesWritten, user, ip, userAgent, url) {
    if (this.level === LEVELS.NONE) {
      return;
    }
    let ds = duration < 2000 ? duration + 'ms' : (duration / 1000 | 0) + 's';
    if (userAgent && userAgent.indexOf('"') >= 0) {
      userAgent = userAgent.replace(/\"/g, '\\"')
    }
    this.commonWriters[LEVELS.ACCESS].write((cluster.isWorker ? `[${cluster.worker.id}] ` : '') + `[${util.formatDate()}] [${code !== 0 && code < 1000 ? code : 200}] [${method}] [${ds}] [${bytesRead}] [${bytesWritten}] [${user ? user : '-'}] [${ip}] "${userAgent || ''}" ${url}\n`);
  }
  _write(level, section, ...args) {
    if (args.length === 0) {
      return;
    }
    let writer;
    if (section === 'ALL') {
      writer = this.commonWriters[level];
    } else {
      let ws = this.writers.get(LEVEL_NAMES[level]);
      if (!ws.has(section)) {
        ws.set(section, new Writer({
          level: LEVEL_NAMES[level],
          section: section,
          path: this.path
        }));
      }
      writer = ws.get(section);
    }
    let msg = this._format(level, ...args);
    writer.write(msg);
  }
}

module.exports = FileLogger;
