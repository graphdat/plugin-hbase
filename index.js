process.on('uncaughtException', function(err) {
  console.log('msg %s, name %s, stack->\n%s', err.message, err.name, err.stack);
});

var _async = require('async');
var _fs = require('fs');
var _jmx = require('jmx');
var _os = require('os');
var _param = require('./param.json');
var _path = require('path');
var _tools = require('graphdat-plugin-tools');

var DEBUG = false;

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

var _pollHandler; // the handler for the poll
var _pollInterval; // the interval to poll the metrics
var _previous; // the previous process count
var _previous_ts; // the previous time the metric was counted
var _source; // the source of the metrics

// ==========
// VALIDATION
// ==========

// change some keys based on HBASE versions
var _newVersion = 'version_095_orAbove' in _param ? _param.version_095_orAbove : true;
if (!_newVersion) {
  var regionServers = JMX_ATTRIBUTES["hadoop:service=RegionServer,name=RegionServerStatistics"];
  regionServers.blockCacheHitCachingRatio = regionServers.blockCacheExpressCachingRatio;
  delete regionServers.blockCacheExpressCachingRatio;
  regionServers.compactionQueueSize = regionServers.compactionQueueLength;
  delete regionServers.compactionQueueLength;
}

// where is the JMX endpoint
var _hostname = _param.hostname || 'localhost';
var _port = _param.port && parseInt(_param.port, 10) || 10102;
var _protocol = _param.protocol || 'rmi';
var _username = _param.username;
var _password = _param.password;

// how often should we poll
var _pollInterval = (_param.pollSeconds && parseFloat(_param.pollSeconds) * 1000) ||
                    (_param.pollInterval) ||
                    5000;

// set the source if we do not have one
var _source = (_param.source && _param.source.trim() !== '') ? _param.source : _os.hostname();

// ===============
// LET GET STARTED
// ===============

// create the JMX client to poll with
var config = {
  host: _hostname,
  port: _port,
  protocol: _protocol
};

if (_username)
  config.username = _username;
if (_password)
  config.password = _password;

var _client = _jmx.createClient(config);
_client.on("error", function(err) {
  console.error(err);
  process.exit(1);
});
_client.on("connect", function() {
  if (DEBUG)
    console.log('connected!');
  if (_pollHandler)
    clearTimeout(_pollHandler);

  // start the polling for our metrics
  poll();
});

// create the polling functions
var funcs = [];
Object.keys(JMX_ATTRIBUTES).forEach(function(key) {
  Object.keys(JMX_ATTRIBUTES[key]).forEach(function(name) {
    funcs.push(function(cb) {

      if (DEBUG)
        console.log('attempting to get %s from %s', name, key);

      _client.getAttribute(key, name, function(data) {

        var attribute = JMX_ATTRIBUTES[key][name];
        var result;
        if (DEBUG)
          console.log(data.toString());

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
        return cb(null, result);
      });
    });
  });
});

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

  var ts = Date.now();
  var ts_delta= diff(ts, _previous_ts);

  _async.parallel(funcs, function(err, current) {

    if (DEBUG)
      console.log(current);

    if (err || current === undefined) {
      _previous = undefined;
      _previous_ts = undefined;
      console.error(err);
      _pollHandler = setTimeout(poll, _pollInterval);
      return;
    }

    if (_previous === undefined) {
      // skip the first value otherwise it would be 0
      _previous = current;
      _previous_ts = ts;
      _pollHandler = setTimeout(poll, _pollInterval);
      return;
    }

    current.forEach(function(metric) {

      if (DEBUG)
        console.log(metric);

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
    _previous_ts = ts;
    _pollHandler = setTimeout(poll, _pollInterval);
  });
}

if (DEBUG)
  console.log('attempting connection');

_client.connect();
