# Graphdat HBase Plugin for Region Servers

### Pre Reqs

1. Enable JMX metrics in HBase - Follow the guide [here](https://hbase.apache.org/metrics.html) to enable JMX collection of your HBase metrics
2. Make sure you have set you JAVA_HOME environment variable - Run `echo $JAVA_HOME` to verify the variable has been set


### Installation & Configuration

* The `Hostname` tells Graphdat which hostname or IP Address to use when calling the JMX endpoint (localhost)
* The `Port` tells Graphdat which port to use when calling the JMX endpoint (10102)
* The `Username` is the username required to call the JMX endpoint. (monitorRole)
* The `Password` is the password required to call the JMX endpoint. (monitorpass)
* The `Source` is the displayed in the legend.  It will default to the hostname of the server
* The `Poll Seconds` is the number of seconds to wait before polling. It will default to 5 seconds.

### Tracks the following metrics from HBase

* HBASE_BLOCK_CACHE_EXPRESS: Block cache hit caching ratio (0 to 100).  The cache-hit ratio for reads configured to look in the cache (i.e., cacheBlocks=true).
* HBASE_COMPACTION_QUEUE: The length of the compaction queue.  This is the number of Stores in the RegionServer that have been targeted for compaction.
* HBASE_FLUSH_QUEUE: The number of enqueued regions in the MemStore awaiting flush.
* HBASE_LOCAL_BLOCK_RATIO: The percentage of HDFS blocks that are local to this RegionServer. The higher the better.
* HBASE_MEMSTORE_SIZE: The sum of all the memstore sizes in this RegionServer. Watch for this nearing or exceeding the configured high-watermark for MemStore memory in the Region Server.
* HBASE_REGIONS: The number of regions served by the RegionServer. This is an important metric to track for RegionServer-Region density.
* HBASE_READ_REQUESTS: The number of read requests for this RegionServer.
* HBASE_SLOW_LOG_APPENDS: The number of slow HLog append writes for this RegionServer since startup, where "slow" is > 1 second. This is a good "canary" metric for HDFS.
* HBASE_MEMORY: The amount of memory used by the RegionServer.
* HBASE_WRITE_REQUESTS: The number of write requests for this RegionServer since startup.
