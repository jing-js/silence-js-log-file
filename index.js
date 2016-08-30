'use strict';

const format = require('util').format;
const util = require('silence-js-util');
const fs = require('fs');
const path = require('path');

const LEVELS = {
  NONE: 4,
  ERROR: 3,
  WARN: 2,
  INFO: 1,
  DEBUG: 0
};
const TIPS = ['[DEBUG]', '[INFO ]', '[WARN ]', '[ERROR]', '[NONE ]'];
const MAX_CACHE_LENGTH = 1000;

function fn(n) {
  return n < 10 ? '0' + n : n.toString();
}

function formatDate(date, short = false, sep = '/') {
  date = date ? date : new Date();
  return `${date.getFullYear()}${sep}${fn(date.getMonth() + 1)}${sep}${fn(date.getDate())}` + (short ? '' : ` ${fn(date.getHours())}:${fn(date.getMinutes())}:${fn(date.getSeconds())}`);
}

function _err(err) {
  console.log(err);
}

class Writer {
  constructor(cfg) {
    this.y = -1;
    this.m = -1;
    this.d = -1;
    this.level = cfg.level || '';
    this.postfix = cfg.level ? `.${cfg.level.toLowerCase()}` : '';
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
      _err('FileLogger cache received MAX_CACHE_LENGTH ' + MAX_CACHE_LENGTH);
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
        `${this.y}-${fn(this.m + 1)}-${fn(this.d)}${this.postfix }.log`
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
    }
  }
}

class FileLogger {
  constructor(config) {
    this.level = LEVELS[(config.level || 'ERROR').toUpperCase()];
    this.path = path.resolve(process.cwd(), config.path || './data/logs');
    this.logWriter = new Writer({
      path: this.path
    });
    this.accessWriter = new Writer({
      level: 'ACCESS',
      path: this.path
    });
    this.errorWriter = new Writer({
      level: 'ERROR',
      path: this.path
    });
  }
  init() {
    return util.mkdirP(this.path);
  }
  close() {
    this.logWriter.close();
    this.accessWriter.close();
    this.errorWriter.close();
  }
  _log(level, ...args) {
    if (level < this.level) {
      return;
    }
    this._write(level, ...args);
  }
  _format(level, ...args) {
    let prefix = `[${formatDate()}] ${TIPS[level]} `;
    if (args.length === 1) {
      return prefix + (typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0].toString()) + '\n';
    } else {
      return prefix + format(...args) + '\n';
    }
  }
  log(...args) {
    this._log(LEVELS.INFO, ...args);
  }
  debug(...args) {
    this._log(LEVELS.DEBUG, ...args);
  }
  error(...args) {
    this._log(LEVELS.ERROR, ...args);
  }
  info(...args) {
    this._log(LEVELS.INFO, ...args);
  }
  warn(...args) {
    this._log(LEVELS.WARN, ...args);
  }
  access(method, code, duration, ip, url) {
    if (this.level === LEVELS.NONE) {
      return;
    }
    this.accessWriter.write(`[${formatDate()}] [${code !== 0 && code < 1000 ? code : 200}] [${method}] [${duration}ms] [${ip}] ${url}\n`);
  }
  _write(level, ...args) {
    if (args.length === 0) {
      return;
    }
    let msg = this._format(level, ...args);
    if (level === LEVELS.ERROR) {
      this.errorWriter.write(msg);
    } else {
      this.logWriter.write(msg);
    }
  }
}

module.exports = FileLogger;
