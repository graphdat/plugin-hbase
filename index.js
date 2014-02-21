process.on('uncaughtException', function(err) {
  console.error('msg %s, name %s, stack->\n%s', err.message, err.name, err.stack);
});

var _async = require('async');
var _exec = require('child_process').exec;
var _fs = require('fs');
var _jmx = require('jmx');
var _os = require('os');
var _param = require('./param.json');
var _tools = require('graphdat-plugin-tools');

var DEBUG = false;

var HBASE_VERSION_WHERE_JMX_KEYS_CHANGED = 95;
var MAX_RETRY_CONNECTIONS = 10;
var RECONNECT_INTERVAL = 30000; // If HBase is restarted, it takes about 30s for custom metrics to be available
var RETRY_CONNECTION_INTERVAL = 5000;

var JMX_ATTRIBUTES = {
  "hadoop:service=RegionServer,name=RegionServerStatistics": {
    blockCacheExpressCachingRatio: { type:'int', graphdatKey: 'HBASE_BLOCK_CACHE_EXPRESS' },
    compactionQueueLength: { type:'int', graphdatKey: 'HBASE_COMPACTION_QUEUE' },
    flushQueueSize: { type:'int', graphdatKey: 'HBASE_FLUSH_QUEUE' },
    hdfsBlocksLocalityIndex: { type:'int', graphdatKey: 'HBASE_LOCAL_BLOCK_RATIO' },
    memstoreSizeMB: { type:'MB', graphdatKey: 'HBASE_MEMSTORE_SIZE' },
    regions: { type:'int', graphdatKey: 'HBASE_REGIONS' },
    readRequestsCount: { type:'sum', graphdatKey: 'HBASE_READ_REQUESTS' },
    slowHLogAppendCount: { type:'sum', graphdatKey: 'HBASE_SLOW_LOG_APPENDS' },
    writeRequestsCount: { type:'sum', graphdatKey: 'HBASE_WRITE_REQUESTS' },
  },
  "java.lang:type=Memory": {
    HeapMemoryUsage: { type: 'MB', subtype: 'used', graphdatKey: 'HBASE_MEMORY' }
  }
};

var _functionsToPoll; // functions to fetch the metrics
var _pollInterval; // the time interval to poll the metrics
var _pollTimeout; // the handler for the poll
var _previous; // the previous process count
var _source; // the source of the metrics

var _client;
var _connectionAttempt = 0;
var _isApplicationClosing = false;
var _isConnected = false;
var _isReconnect = false;
var _reconnectAt;
var _reconnectTimeout;

// ==========
// VALIDATION
// ==========

// where is the JMX endpoint
var _hostname = _param.hostname || 'localhost';
var _port = _param.port && parseInt(_param.port, 10) || 10102;
var _protocol = _param.protocol || 'rmi';
var _username = _param.username;
var _password = _param.password;

// how often should we poll
_pollInterval = (_param.pollSeconds && parseFloat(_param.pollSeconds) * 1000) ||
                (_param.pollInterval) ||
                5000;

// set the source if we do not have one
_source = (_param.source && _param.source.trim() !== '') ? _param.source : _os.hostname();


// Is the the plugin being run on a server with the region service
function checkRegionServer(cb) {
  _exec('ps aux | grep HRegionServer | grep -v grep', function (err, stdout, stderr) {
    if (err || stderr || !stdout)
      return cb('The Graphdat HBase plugin should be run on a Region Server');
    else
      return cb(null);
  });
}

// Is the the plugin being run on a server with the region service
function checkHBaseVersion(cb) {
  var errmsg = 'Cannot detect the HBase version';
  _exec('hbase version', function (err, stdout, stderr) {
    if (err)
      return cb(errmsg);

    var lines = (stderr || stdout).split('\n');
    if (!lines || lines.length === 0)
      return cb(errmsg);

    var match = lines[0].match(/HBase \w+.(\w+).\w+/);
    if (!match)
      return cb(errmsg);

    var version = parseInt(match[1], 10);
    if (isNaN(version))
      return cb(errmsg);

    if (version < HBASE_VERSION_WHERE_JMX_KEYS_CHANGED) {
      var regionServers = JMX_ATTRIBUTES["hadoop:service=RegionServer,name=RegionServerStatistics"];

      // blockCacheExpressCachingRatio used to be called blockCacheHitCachingRatio
      regionServers.blockCacheHitCachingRatio = regionServers.blockCacheExpressCachingRatio;
      delete regionServers.blockCacheExpressCachingRatio;

      // compactionQueueLength used to be called compactionQueueSize
      regionServers.compactionQueueSize = regionServers.compactionQueueLength;
      delete regionServers.compactionQueueLength;
    }

    return cb(null);
  });
}

// create the polling functions
function generate(cb) {
  _functionsToPoll = [];
  Object.keys(JMX_ATTRIBUTES).forEach(function(key) {
    Object.keys(JMX_ATTRIBUTES[key]).forEach(function(name) {
      _functionsToPoll.push(function(inner_cb) {

        if (DEBUG) console.log('attempting to get %s from %s', name, key);

        _client.getAttribute(key, name, function(data) {

          var attribute = JMX_ATTRIBUTES[key][name];
          var result;

          if (data !== undefined) {
            result = { key: key, name:name, type:attribute.type, graphdatKey:attribute.graphdatKey };

            switch(attribute.type) {
              case 'int':
              case 'sum':
                result.value = data;
                break;
              case 'MB':
                if ('subtype' in attribute)
                  result.value = data.getSync(attribute.subtype).longValue;
                else
                  result.value = data * 1024 * 1024;
                break;
            }
          }
          return inner_cb && inner_cb(null, result);
        });
      });
    });
  });
  return cb(null);
}

// helper to diff two numbers
function diff(a, b) {
  if (a == null || b == null || isNaN(a) || isNaN(b))
    return undefined;
  else if (a<b)
    return undefined; // int rolled over, ignore the value
  else
    return a - b;
}

// get the stats, format the output and send to stdout
function poll(cb) {

  _async.series(_functionsToPoll, function(err, current) {

    if (DEBUG) {
      console.log('poll() - current');
      console.log(current);
    }

    if (err || current == null) {
      console.error('error in poll()');
      console.error(err);
      _previous = undefined;
      _pollTimeout = setTimeout(poll, _pollInterval);
      return;
    }

    if (_previous === undefined) {
      // skip the first value otherwise it would be 0
      if (DEBUG) console.log('skipping first record in poll');
      _previous = current;
      _pollTimeout = setTimeout(poll, _pollInterval);
      return;
    }

    // things are good, lets process the values
    if (DEBUG) console.log('poll() has values');
    current.forEach(function(metric) {
      var value;
      switch(metric.type) {
        case 'sum':
          var prev = _previous.filter(function(p) { return p.graphdatKey === metric.graphdatKey; });
          if (prev && prev.length === 1)
            value = diff(metric.value, prev.value);
          break;
        default:
          value = metric.value;
          break;
      }
      if (value !== undefined)
        console.log('%s %s %s', metric.graphdatKey, value, _source);
    });

    _previous = current;
    _pollTimeout = setTimeout(poll, _pollInterval);
  });
}

// ===============
// LET GET STARTED
// ===============

// create the JMX client to poll with
_client = _jmx.createClient({
  host: _hostname,
  port: _port,
  protocol: _protocol,
  username: _username,
  password: _password
});

function connect() {

  if (_isConnected === true) {
    if (DEBUG) console.log('skipping connect(), we are already connected');
    return;
  }

  if (_reconnectTimeout) {
    clearTimeout(_reconnectTimeout);
    _reconnectTimeout = null;
  }

  if (DEBUG) console.log('Attempting connection');
  _connectionAttempt++;
  _client.connect();
}

function reconnect() {

  if (_isConnected === true) {
    if (DEBUG) console.log('skipping reconnect(), we are already connected');
    return;
  }
  if (_connectionAttempt > MAX_RETRY_CONNECTIONS) {
    if (DEBUG) console.log('exceeded the number of attempts');
    return;
  }

  var interval = (RETRY_CONNECTION_INTERVAL * _connectionAttempt) + RETRY_CONNECTION_INTERVAL;
  var now = Date.now();
  var reconnectTime = now + interval;

  if (!_reconnectAt ||  // have not scheduled a reconnection
      _reconnectAt < now ||  // the reconnection is in the past
      reconnectTime < _reconnectAt) { // the reconnection is sooner as we have another error

    console.log('Will attempt to reconnect to in ' + interval/1000 + ' secs');

    _isReconnect = true;
    _reconnectAt = reconnectTime;
    clearTimeout(_reconnectTimeout);
    _reconnectTimeout = setTimeout(connect, interval);
  }
  else {
    if (DEBUG) console.log('ignoring reconnect()');
  }
}

function disconnect() {

  if (!_isConnected) {
    if (DEBUG) console.log('skipping disconnect(), we are not connected');
    return;
  }

  if (DEBUG) console.log('disconnect()');
  if (_client)
    _client.disconnect();
}

_client.on("error", function(err) {

  if (DEBUG) console.log('on client.error');

  // If the connection was refused, re-try
  if (err && err.message && err.message.match(/Connection refused to host/)) {
    _isConnected = false;
    if (_pollTimeout) {
      clearTimeout(_pollTimeout);
      _pollTimeout = null;
    }
    reconnect();
  }
  else {
    console.error(err);
    process.exit(1);
  }
});

_client.on("connect", function() {

  if (DEBUG) console.log('on client.connect');
  var isReconnect = _isReconnect;

  _connectionAttempt = 0;
  _isConnected = true;
  _isReconnect = false;
  _reconnectAt = undefined;

  if (_reconnectTimeout) {
    clearTimeout(_reconnectTimeout);
    _reconnectTimeout = null;
  }
  if (_pollTimeout) {
    clearTimeout(_pollTimeout);
    _pollTimeout = null;
  }

  // start the polling for our metrics
  _pollTimeout = setTimeout(poll, (isReconnect) ? RECONNECT_INTERVAL : _pollInterval);
});

_client.on('disconnect', function() {

  if (DEBUG) console.log('on client.disconnect');

  _isConnected = false;
  if (_pollTimeout) {
    clearTimeout(_pollTimeout);
    _pollTimeout = null;
  }
  if (!_isApplicationClosing)
    reconnect();
});

process.on('SIGINT', closeAndExit);
process.on('SIGKILL', closeAndExit);
process.on('SIGTERM', closeAndExit);
function closeAndExit()
{
  _isApplicationClosing = true;
  disconnect();
  if (_pollTimeout)
  {
    clearTimeout(_pollTimeout);
    _pollTimeout = null;
  }
  if (_reconnectTimeout)
  {
     clearTimeout(_reconnectTimeout);
    _reconnectTimeout = null;
  }
  process.exit(0);
}

_async.series([
    // function(cb) { checkRegionServer(cb); }, // make sure this is a region server
    function(cb) { checkHBaseVersion(cb); }, // different HBase version use different keys
    function(cb) { generate(cb); } // now we have the keys, generate the polling functions
  ],
  function(err, results) {
    if (err) {
      console.error('startup');
      console.error(err);
      process.exit(1);
    }
    connect();
  }
);
