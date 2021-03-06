/**
 * Sets up a replica set. To make the set running, call {@link #startSet},
 * followed by {@link #initiate} (and optionally,
 * {@link #awaitSecondaryNodes} to block till the  set is fully operational).
 * Note that some of the replica start up parameters are not passed here,
 * but to the #startSet method.
 *
 * @param {Object|string} opts If this value is a string, it specifies the connection string for
 *      a MongoD host to be used for recreating a ReplSetTest from. Otherwise, if it is an object,
 *      it must have the following contents:
 *
 *   {
 *     name {string}: name of this replica set. Default: 'testReplSet'
 *     host {string}: name of the host machine. Hostname will be used
 *        if not specified.
 *     useHostName {boolean}: if true, use hostname of machine,
 *        otherwise use localhost
 *     nodes {number|Object|Array.<Object>}: number of replicas. Default: 0.
 *        Can also be an Object (or Array).
 *        Format for Object:
 *          {
 *            <any string>: replica member option Object. @see MongoRunner.runMongod
 *            <any string2>: and so on...
 *          }
 *          If object has a special "rsConfig" field then those options will be used for each
 *          replica set member config options when used to initialize the replica set, or
 *          building the config with getReplSetConfig()
 *
 *        Format for Array:
 *           An array of replica member option Object. @see MongoRunner.runMongod
 *
 *        Note: For both formats, a special boolean property 'arbiter' can be
 *          specified to denote a member is an arbiter.
 *
 *        Note: A special "bridgeOptions" property can be specified in both the object and array
 *           formats to configure the options for the mongobridge corresponding to that node. These
 *           options are merged with the opts.bridgeOptions options, where the node-specific options
 *           take precedence.
 *
 *     nodeOptions {Object}: Options to apply to all nodes in the replica set.
 *        Format for Object:
 *          { cmdline-param-with-no-arg : "",
 *            param-with-arg : arg }
 *        This turns into "mongod --cmdline-param-with-no-arg --param-with-arg arg"
 *
 *     oplogSize {number}: Default: 40
 *     useSeedList {boolean}: Use the connection string format of this set
 *        as the replica set name (overrides the name property). Default: false
 *     keyFile {string}
 *     protocolVersion {number}: protocol version of replset used by the replset initiation.
 *
 *     useBridge {boolean}: If true, then a mongobridge process is started for each node in the
 *        replica set. Both the replica set configuration and the connections returned by startSet()
 *        will be references to the proxied connections. Defaults to false.
 *
 *     bridgeOptions {Object}: Options to apply to all mongobridge processes. Defaults to {}.
 *
 *     settings {object}: Setting used in the replica set config document.
 *        Example:
 *              settings: { chainingAllowed: false, ... }
 *   }
 *
 * Member variables:
 *  nodes {Array.<Mongo>} - connection to replica set members
 */
var ReplSetTest = function(opts) {
    'use strict';

    if (!(this instanceof ReplSetTest)) {
        return new ReplSetTest(opts);
    }

    // Capture the 'this' reference
    var self = this;

    // Replica set health states
    var Health = {UP: 1, DOWN: 0};

    var _alldbpaths;
    var _configSettings;

    // mongobridge related variables. Only available if the bridge option is selected.
    var _useBridge;
    var _bridgeOptions;
    var _unbridgedPorts;
    var _unbridgedNodes;

    this.kDefaultTimeoutMs = 5 * 60 * 1000;

    // Publicly exposed variables

    /**
     * Populates a reference to all reachable nodes.
     */
    function _clearLiveNodes() {
        self.liveNodes = {master: null, slaves: []};
    }

    /**
     * Returns the config document reported from the specified connection.
     */
    function _replSetGetConfig(conn) {
        return assert.commandWorked(conn.adminCommand({replSetGetConfig: 1})).config;
    }

    /**
     * Invokes the 'ismaster' command on each individual node and returns whether the node is the
     * current RS master.
     */
    function _callIsMaster() {
        _clearLiveNodes();

        var twoPrimaries = false;
        self.nodes.forEach(function(node) {
            try {
                var n = node.getDB('admin').runCommand({ismaster: 1});
                if (n.ismaster == true) {
                    if (self.liveNodes.master) {
                        twoPrimaries = true;
                    } else {
                        self.liveNodes.master = node;
                    }
                } else {
                    node.setSlaveOk();
                    self.liveNodes.slaves.push(node);
                }
            } catch (err) {
                print("ReplSetTest Could not call ismaster on node " + node + ": " + tojson(err));
            }
        });
        if (twoPrimaries) {
            return false;
        }

        return self.liveNodes.master || false;
    }

    /**
     * Wait for a rs indicator to go to a particular state or states.
     *
     * @param node is a single node or list of nodes, by id or conn
     * @param states is a single state or list of states
     * @param ind is the indicator specified
     * @param timeout how long to wait for the state to be reached
     */
    function _waitForIndicator(node, states, ind, timeout) {
        if (node.length) {
            var nodes = node;
            for (var i = 0; i < nodes.length; i++) {
                if (states.length)
                    _waitForIndicator(nodes[i], states[i], ind, timeout);
                else
                    _waitForIndicator(nodes[i], states, ind, timeout);
            }

            return;
        }

        timeout = timeout || self.kDefaultTimeoutMS;

        if (!node.getDB) {
            node = self.nodes[node];
        }

        if (!states.length) {
            states = [states];
        }

        print("ReplSetTest waitForIndicator " + ind + " on " + node);
        printjson(states);
        print("ReplSetTest waitForIndicator from node " + node);

        var lastTime = null;
        var currTime = new Date().getTime();
        var status;

        assert.soon(function() {
            try {
                var conn = _callIsMaster();
                if (!conn) {
                    conn = self.liveNodes.slaves[0];
                }

                // Try again to load connection
                if (!conn)
                    return false;

                var getStatusFunc = function() {
                    status = conn.getDB('admin').runCommand({replSetGetStatus: 1});
                };

                if (self.keyFile) {
                    // Authenticate connection used for running replSetGetStatus if needed
                    authutil.asCluster(conn, self.keyFile, getStatusFunc);
                } else {
                    getStatusFunc();
                }
            } catch (ex) {
                print("ReplSetTest waitForIndicator could not get status: " + tojson(ex));
                return false;
            }

            var printStatus = false;
            if (lastTime == null || (currTime = new Date().getTime()) - (1000 * 5) > lastTime) {
                if (lastTime == null) {
                    print("ReplSetTest waitForIndicator Initial status (timeout : " + timeout +
                          ") :");
                }

                printjson(status);
                lastTime = new Date().getTime();
                printStatus = true;
            }

            if (typeof status.members == 'undefined') {
                return false;
            }

            for (var i = 0; i < status.members.length; i++) {
                if (printStatus) {
                    print("Status for : " + status.members[i].name + ", checking " + node.host +
                          "/" + node.name);
                }

                if (status.members[i].name == node.host || status.members[i].name == node.name) {
                    for (var j = 0; j < states.length; j++) {
                        if (printStatus) {
                            print("Status -- " + " current state: " + status.members[i][ind] +
                                  ",  target state : " + states[j]);
                        }

                        if (typeof(states[j]) != "number") {
                            throw new Error("State was not an number -- type:" + typeof(states[j]) +
                                            ", value:" + states[j]);
                        }
                        if (status.members[i][ind] == states[j]) {
                            return true;
                        }
                    }
                }
            }

            return false;

        }, "waiting for state indicator " + ind + " for " + timeout + "ms", timeout);

        print("ReplSetTest waitForIndicator final status:");
        printjson(status);
    }

    /**
     * Wait for a health indicator to go to a particular state or states.
     *
     * @param node is a single node or list of nodes, by id or conn
     * @param state is a single state or list of states. ReplSetTest.Health.DOWN can
     *     only be used in cases when there is a primary available or slave[0] can
     *     respond to the isMaster command.
     */
    function _waitForHealth(node, state, timeout) {
        _waitForIndicator(node, state, "health", timeout);
    }

    /**
     * Returns the optime for the specified host by issuing replSetGetStatus.
     */
    function _getLastOpTime(conn) {
        var replSetStatus =
            assert.commandWorked(conn.getDB("admin").runCommand({replSetGetStatus: 1}));
        var connStatus = replSetStatus.members.filter(m => m.self)[0];
        return connStatus.optime;
    }

    /**
     * Returns the OpTime timestamp for the specified host by issuing replSetGetStatus.
     */
    function _getLastOpTimeTimestamp(conn) {
        var myOpTime = _getLastOpTime(conn);
        if (!myOpTime) {
            // Must be an ARBITER
            return undefined;
        }

        return myOpTime.ts ? myOpTime.ts : myOpTime;
    }

    /**
     * Returns the last committed OpTime for the replicaset as known by the host.
     * This function may return an OpTime with Timestamp(0,0) and Term(0) if there is no
     * last committed OpTime.
     */
    function _getLastCommittedOpTime(conn) {
        var replSetStatus =
            assert.commandWorked(conn.getDB("admin").runCommand({replSetGetStatus: 1}));
        return (replSetStatus.OpTimes || replSetStatus.optimes).lastCommittedOpTime ||
            {ts: Timestamp(0, 0), t: NumberLong(0)};
    }

    /**
     * Returns the {readConcern: majority} OpTime for the host.
     * This is the OpTime of the host's "majority committed" snapshot.
     * This function may return an OpTime with Timestamp(0,0) and Term(0) if read concern majority
     * is not enabled, or if there has not been a committed snapshot yet.
     */
    function _getReadConcernMajorityOpTime(conn) {
        var replSetStatus =
            assert.commandWorked(conn.getDB("admin").runCommand({replSetGetStatus: 1}));
        return (replSetStatus.OpTimes || replSetStatus.optimes).readConcernMajorityOpTime ||
            {ts: Timestamp(0, 0), t: NumberLong(0)};
    }

    /**
     * Returns the last durable OpTime timestamp for the host if running with journaling.
     * Returns the last applied OpTime timestamp otherwise.
     */
    function _getDurableOpTimeTimestamp(conn) {
        var replSetStatus =
            assert.commandWorked(conn.getDB("admin").runCommand({replSetGetStatus: 1}));

        var runningWithoutJournaling = TestData.noJournal || "inMemory" == TestData.storageEngine ||
            "ephemeralForTest" == TestData.storageEngine;
        var opTimeType = "durableOpTime";
        if (runningWithoutJournaling) {
            opTimeType = "appliedOpTime";
        }
        return replSetStatus.optimes[opTimeType].ts;
    }

    function _isEarlierTimestamp(ts1, ts2) {
        if (ts1.getTime() == ts2.getTime()) {
            return ts1.getInc() < ts2.getInc();
        }
        return ts1.getTime() < ts2.getTime();
    }

    function _isEarlierOpTime(ot1, ot2) {
        // Make sure both optimes have a timestamp and a term.
        ot1 = ot1.t ? ot1 : {ts: ot1, t: NumberLong(-1)};
        ot2 = ot2.t ? ot2 : {ts: ot2, t: NumberLong(-1)};

        // If both optimes have a term that's not -1 and one has a lower term, return that optime.
        if (!friendlyEqual(ot1.t, NumberLong(-1)) && !friendlyEqual(ot2.t, NumberLong(-1))) {
            if (!friendlyEqual(ot1.t, ot2.t)) {
                return ot1.t < ot2.t;
            }
        }

        // Otherwise, choose the optime with the lower timestamp.
        return _isEarlierTimestamp(ot1.ts, ot2.ts);
    }

    /**
     * Returns list of nodes as host:port strings.
     */
    this.nodeList = function() {
        var list = [];
        for (var i = 0; i < this.ports.length; i++) {
            list.push(this.host + ":" + this.ports[i]);
        }

        return list;
    };

    this.getNodeId = function(node) {
        if (node.toFixed) {
            return parseInt(node);
        }

        for (var i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i] == node) {
                return i;
            }
        }

        if (node instanceof ObjectId) {
            for (i = 0; i < this.nodes.length; i++) {
                if (this.nodes[i].runId == node) {
                    return i;
                }
            }
        }

        if (node.nodeId != null) {
            return parseInt(node.nodeId);
        }

        return undefined;
    };

    this.getPort = function(n) {
        var n = this.getNodeId(n);
        return this.ports[n];
    };

    this._addPath = function(p) {
        if (!_alldbpaths)
            _alldbpaths = [p];
        else
            _alldbpaths.push(p);

        return p;
    };

    this.getReplSetConfig = function() {
        var cfg = {};
        cfg._id = this.name;

        if (this.protocolVersion !== undefined && this.protocolVersion !== null) {
            cfg.protocolVersion = this.protocolVersion;
        }

        cfg.members = [];

        for (var i = 0; i < this.ports.length; i++) {
            var member = {};
            member._id = i;

            var port = this.ports[i];
            member.host = this.host + ":" + port;

            var nodeOpts = this.nodeOptions["n" + i];
            if (nodeOpts) {
                if (nodeOpts.arbiter) {
                    member.arbiterOnly = true;
                }

                if (nodeOpts.rsConfig) {
                    Object.extend(member, nodeOpts.rsConfig);
                }
            }

            cfg.members.push(member);
        }

        if (jsTestOptions().useLegacyReplicationProtocol) {
            cfg.protocolVersion = 0;
        }

        if (_configSettings) {
            cfg.settings = _configSettings;
        }

        return cfg;
    };

    this.getURL = function() {
        var hosts = [];

        for (var i = 0; i < this.ports.length; i++) {
            hosts.push(this.host + ":" + this.ports[i]);
        }

        return this.name + "/" + hosts.join(",");
    };

    /**
     * Starts each node in the replica set with the given options.
     *
     * @param options - The options passed to {@link MongoRunner.runMongod}
     */
    this.startSet = function(options) {
        print("ReplSetTest starting set");

        var nodes = [];
        for (var n = 0; n < this.ports.length; n++) {
            nodes.push(this.start(n, options));
        }

        this.nodes = nodes;
        return this.nodes;
    };

    /**
     * Blocks until the secondary nodes have completed recovery and their roles are known.
     */
    this.awaitSecondaryNodes = function(timeout) {
        timeout = timeout || self.kDefaultTimeoutMS;

        assert.soonNoExcept(function() {
            // Reload who the current slaves are
            self.getPrimary(timeout);

            var slaves = self.liveNodes.slaves;
            var len = slaves.length;
            var ready = true;

            for (var i = 0; i < len; i++) {
                var isMaster = slaves[i].getDB("admin").runCommand({ismaster: 1});
                var arbiter = (isMaster.arbiterOnly == undefined ? false : isMaster.arbiterOnly);
                ready = ready && (isMaster.secondary || arbiter);
            }

            return ready;
        }, "Awaiting secondaries", timeout);
    };

    /**
     * Blocks until all nodes agree on who the primary is.
     */
    this.awaitNodesAgreeOnPrimary = function(timeout) {
        timeout = timeout || self.kDefaultTimeoutMS;

        assert.soonNoExcept(function() {
            var primary = -1;

            for (var i = 0; i < self.nodes.length; i++) {
                var replSetGetStatus =
                    self.nodes[i].getDB("admin").runCommand({replSetGetStatus: 1});
                var nodesPrimary = -1;
                for (var j = 0; j < replSetGetStatus.members.length; j++) {
                    if (replSetGetStatus.members[j].state === ReplSetTest.State.PRIMARY) {
                        // Node sees two primaries.
                        if (nodesPrimary !== -1) {
                            return false;
                        }
                        nodesPrimary = j;
                    }
                }
                // Node doesn't see a primary.
                if (nodesPrimary < 0) {
                    return false;
                }

                if (primary < 0) {
                    // If we haven't seen a primary yet, set it to this.
                    primary = nodesPrimary;
                } else if (primary !== nodesPrimary) {
                    return false;
                }
            }

            return true;
        }, "Awaiting nodes to agree on primary", timeout);
    };

    /**
     * Blocking call, which will wait for a primary to be elected for some pre-defined timeout and
     * if primary is available will return a connection to it. Otherwise throws an exception.
     */
    this.getPrimary = function(timeout) {
        timeout = timeout || self.kDefaultTimeoutMS;
        var primary = null;

        assert.soonNoExcept(function() {
            primary = _callIsMaster();
            return primary;
        }, "Finding primary", timeout);

        return primary;
    };

    this.awaitNoPrimary = function(msg, timeout) {
        msg = msg || "Timed out waiting for there to be no primary in replset: " + this.name;
        timeout = timeout || self.kDefaultTimeoutMS;

        assert.soonNoExcept(function() {
            return _callIsMaster() == false;
        }, msg, timeout);
    };

    this.getSecondaries = function(timeout) {
        var master = this.getPrimary(timeout);
        var secs = [];
        for (var i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i] != master) {
                secs.push(this.nodes[i]);
            }
        }

        return secs;
    };

    this.getSecondary = function(timeout) {
        return this.getSecondaries(timeout)[0];
    };

    this.status = function(timeout) {
        var master = _callIsMaster();
        if (!master) {
            master = this.liveNodes.slaves[0];
        }

        return master.getDB("admin").runCommand({replSetGetStatus: 1});
    };

    /**
     * Adds a node to the replica set managed by this instance.
     */
    this.add = function(config) {
        var nextPort = allocatePort();
        print("ReplSetTest Next port: " + nextPort);

        this.ports.push(nextPort);
        printjson(this.ports);

        if (_useBridge) {
            _unbridgedPorts.push(allocatePort());
        }

        var nextId = this.nodes.length;
        printjson(this.nodes);

        print("ReplSetTest nextId: " + nextId);
        return this.start(nextId, config);
    };

    this.remove = function(nodeId) {
        nodeId = this.getNodeId(nodeId);
        this.nodes.splice(nodeId, 1);
        this.ports.splice(nodeId, 1);

        if (_useBridge) {
            _unbridgedPorts.splice(nodeId, 1);
            _unbridgedNodes.splice(nodeId, 1);
        }
    };

    this._setDefaultConfigOptions = function(config) {
        if (jsTestOptions().useLegacyReplicationProtocol &&
            !config.hasOwnProperty("protocolVersion")) {
            config.protocolVersion = 0;
        }
    };

    this.initiate = function(cfg, initCmd, timeout) {
        var master = this.nodes[0].getDB("admin");
        var config = cfg || this.getReplSetConfig();
        var cmd = {};
        var cmdKey = initCmd || 'replSetInitiate';
        timeout = timeout || self.kDefaultTimeoutMS;

        this._setDefaultConfigOptions(config);

        cmd[cmdKey] = config;
        printjson(cmd);

        assert.commandWorked(master.runCommand(cmd), tojson(cmd));
        this.awaitSecondaryNodes(timeout);

        // Setup authentication if running test with authentication
        if ((jsTestOptions().keyFile) && cmdKey == 'replSetInitiate') {
            master = this.getPrimary();
            jsTest.authenticateNodes(this.nodes);
        }
    };

    /**
     * Gets the current replica set config from the specified node index. If no nodeId is specified,
     * uses the primary node.
     */
    this.getReplSetConfigFromNode = function(nodeId) {
        if (nodeId == undefined) {
            // Use 90 seconds timeout for finding a primary
            return _replSetGetConfig(self.getPrimary(90 * 1000));
        }

        if (!isNumber(nodeId)) {
            throw Error(nodeId + ' is not a number');
        }

        return _replSetGetConfig(self.nodes[nodeId]);
    };

    this.reInitiate = function() {
        var config = this.getReplSetConfig();
        var newVersion = this.getReplSetConfigFromNode().version + 1;
        config.version = newVersion;

        this._setDefaultConfigOptions(config);

        try {
            assert.commandWorked(this.getPrimary().adminCommand({replSetReconfig: config}));
        } catch (e) {
            if (tojson(e).indexOf("error doing query: failed") < 0) {
                throw e;
            }
        }
    };

    /**
     * Waits for the last oplog entry on the primary to be visible in the committed snapshop view
     * of the oplog on *all* secondaries.
     * Returns last oplog entry.
     */
    this.awaitLastOpCommitted = function() {
        var rst = this;
        var master = rst.getPrimary();
        var masterOpTime = _getLastOpTime(master);

        print("Waiting for op with OpTime " + tojson(masterOpTime) +
              " to be committed on all secondaries");

        assert.soonNoExcept(function() {
            for (var i = 0; i < rst.nodes.length; i++) {
                var node = rst.nodes[i];

                // Continue if we're connected to an arbiter
                var res = assert.commandWorked(node.adminCommand({replSetGetStatus: 1}));
                if (res.myState == ReplSetTest.State.ARBITER) {
                    continue;
                }
                var rcmOpTime = _getReadConcernMajorityOpTime(node);
                if (friendlyEqual(rcmOpTime, {ts: Timestamp(0, 0), t: NumberLong(0)})) {
                    return false;
                }
                if (_isEarlierOpTime(rcmOpTime, masterOpTime)) {
                    return false;
                }
            }

            return true;
        }, "Op with OpTime " + tojson(masterOpTime) + " failed to be committed on all secondaries");

        return masterOpTime;
    };

    // Wait until the optime of the specified type reaches the primary's last applied optime.
    this.awaitReplication = function(timeout, secondaryOpTimeType) {
        timeout = timeout || self.kDefaultTimeoutMS;
        secondaryOpTimeType = secondaryOpTimeType || ReplSetTest.OpTimeType.LAST_APPLIED;

        var masterLatestOpTime;

        // Blocking call, which will wait for the last optime written on the master to be available
        var awaitLastOpTimeWrittenFn = function() {
            var master = self.getPrimary();
            assert.soonNoExcept(function() {
                try {
                    masterLatestOpTime = _getLastOpTimeTimestamp(master);
                } catch (e) {
                    print("ReplSetTest caught exception " + e);
                    return false;
                }

                return true;
            }, "awaiting oplog query", timeout);
        };

        awaitLastOpTimeWrittenFn();

        // get the latest config version from master. if there is a problem, grab master and try
        // again
        var configVersion;
        var masterOpTime;
        var masterName;
        var master;

        try {
            master = this.getPrimary();
            configVersion = this.getReplSetConfigFromNode().version;
            masterOpTime = _getLastOpTimeTimestamp(master);
            masterName = master.toString().substr(14);  // strip "connection to "
        } catch (e) {
            master = this.getPrimary();
            configVersion = this.getReplSetConfigFromNode().version;
            masterOpTime = _getLastOpTimeTimestamp(master);
            masterName = master.toString().substr(14);  // strip "connection to "
        }

        print("ReplSetTest awaitReplication: starting: timestamp for primary, " + masterName +
              ", is " + tojson(masterLatestOpTime) + ", last oplog entry is " +
              tojsononeline(masterOpTime));

        assert.soonNoExcept(function() {
            try {
                print("ReplSetTest awaitReplication: checking secondaries against timestamp " +
                      tojson(masterLatestOpTime));
                var secondaryCount = 0;
                for (var i = 0; i < self.liveNodes.slaves.length; i++) {
                    var slave = self.liveNodes.slaves[i];
                    var slaveName = slave.toString().substr(14);  // strip "connection to "

                    var slaveConfigVersion =
                        slave.getDB("local")['system.replset'].findOne().version;

                    if (configVersion != slaveConfigVersion) {
                        print("ReplSetTest awaitReplication: secondary #" + secondaryCount + ", " +
                              slaveName + ", has config version #" + slaveConfigVersion +
                              ", but expected config version #" + configVersion);

                        if (slaveConfigVersion > configVersion) {
                            master = this.getPrimary();
                            configVersion =
                                master.getDB("local")['system.replset'].findOne().version;
                            masterOpTime = _getLastOpTimeTimestamp(master);
                            masterName = master.toString().substr(14);  // strip "connection to "

                            print("ReplSetTest awaitReplication: timestamp for primary, " +
                                  masterName + ", is " + tojson(masterLatestOpTime) +
                                  ", last oplog entry is " + tojsononeline(masterOpTime));
                        }

                        return false;
                    }

                    // Continue if we're connected to an arbiter
                    var res = assert.commandWorked(slave.adminCommand({replSetGetStatus: 1}));
                    if (res.myState == ReplSetTest.State.ARBITER) {
                        continue;
                    }

                    ++secondaryCount;
                    print("ReplSetTest awaitReplication: checking secondary #" + secondaryCount +
                          ": " + slaveName);

                    slave.getDB("admin").getMongo().setSlaveOk();

                    var getSecondaryTimestampFn = _getLastOpTimeTimestamp;
                    if (secondaryOpTimeType == ReplSetTest.OpTimeType.LAST_DURABLE) {
                        getSecondaryTimestampFn = _getDurableOpTimeTimestamp;
                    }

                    var ts = getSecondaryTimestampFn(slave);
                    if (masterLatestOpTime.t < ts.t ||
                        (masterLatestOpTime.t == ts.t && masterLatestOpTime.i < ts.i)) {
                        masterLatestOpTime = _getLastOpTimeTimestamp(master);
                        print("ReplSetTest awaitReplication: timestamp for " + slaveName +
                              " is newer, resetting latest to " + tojson(masterLatestOpTime));
                        return false;
                    }

                    if (!friendlyEqual(masterLatestOpTime, ts)) {
                        print("ReplSetTest awaitReplication: timestamp for secondary #" +
                              secondaryCount + ", " + slaveName + ", is " + tojson(ts) +
                              " but latest is " + tojson(masterLatestOpTime));
                        print("ReplSetTest awaitReplication: secondary #" + secondaryCount + ", " +
                              slaveName + ", is NOT synced");
                        return false;
                    }

                    print("ReplSetTest awaitReplication: secondary #" + secondaryCount + ", " +
                          slaveName + ", is synced");
                }

                print("ReplSetTest awaitReplication: finished: all " + secondaryCount +
                      " secondaries synced at timestamp " + tojson(masterLatestOpTime));
                return true;
            } catch (e) {
                print("ReplSetTest awaitReplication: caught exception " + e + ';\n' + e.stack);

                // We might have a new master now
                awaitLastOpTimeWrittenFn();

                print("ReplSetTest awaitReplication: resetting: timestamp for primary " +
                      self.liveNodes.master + " is " + tojson(masterLatestOpTime));

                return false;
            }
        }, "awaiting replication", timeout);
    };

    this.getHashes = function(db) {
        this.getPrimary();
        var res = {};
        res.master = this.liveNodes.master.getDB(db).runCommand("dbhash");
        res.slaves = [];
        this.liveNodes.slaves.forEach(function(node) {
            var isArbiter = node.getDB('admin').isMaster('admin').arbiterOnly;
            if (!isArbiter) {
                res.slaves.push(node.getDB(db).runCommand("dbhash"));
            }
        });
        return res;
    };

    this.dumpOplog = function(conn, limit) {
        print('Dumping the latest ' + limit + ' documents from the oplog of ' + conn.host);
        var cursor =
            conn.getDB('local').getCollection('oplog.rs').find().sort({$natural: -1}).limit(limit);
        cursor.forEach(printjsononeline);
    };

    this.checkReplicatedDataHashes = function(excludedDBs = [], msgPrefix = undefined) {
        // TODO: Remove nested functions -- SERVER-25644
        'use strict';
        function checkDBHashes(rst, dbBlacklist = [], msgPrefix = 'checkReplicatedDataHashes') {
            function generateUniqueDbName(dbNames, prefix) {
                var uniqueDbName;
                Random.setRandomSeed();
                do {
                    uniqueDbName = prefix + Random.randInt(100000);
                } while (dbNames.has(uniqueDbName));
                return uniqueDbName;
            }

            // Return items that are in either Array `a` or `b` but not both. Note that this will
            // not work with arrays containing NaN. Array.indexOf(NaN) will always return -1.
            function arraySymmetricDifference(a, b) {
                var inAOnly = a.filter(function(elem) {
                    return b.indexOf(elem) < 0;
                });

                var inBOnly = b.filter(function(elem) {
                    return a.indexOf(elem) < 0;
                });

                return inAOnly.concat(inBOnly);
            }

            function dumpCollectionDiff(primary, secondary, dbName, collName) {
                print('Dumping collection: ' + dbName + '.' + collName);

                var primaryColl = primary.getDB(dbName).getCollection(collName);
                var secondaryColl = secondary.getDB(dbName).getCollection(collName);

                var primaryDocs = primaryColl.find().sort({_id: 1}).toArray();
                var secondaryDocs = secondaryColl.find().sort({_id: 1}).toArray();

                var primaryIndex = primaryDocs.length - 1;
                var secondaryIndex = secondaryDocs.length - 1;

                var missingOnPrimary = [];
                var missingOnSecondary = [];

                while (primaryIndex >= 0 || secondaryIndex >= 0) {
                    var primaryDoc = primaryDocs[primaryIndex];
                    var secondaryDoc = secondaryDocs[secondaryIndex];

                    if (primaryIndex < 0) {
                        missingOnPrimary.push(tojsononeline(secondaryDoc));
                        secondaryIndex--;
                    } else if (secondaryIndex < 0) {
                        missingOnSecondary.push(tojsononeline(primaryDoc));
                        primaryIndex--;
                    } else {
                        if (!bsonBinaryEqual(primaryDoc, secondaryDoc)) {
                            print('Mismatching documents:');
                            print('    primary: ' + tojsononeline(primaryDoc));
                            print('    secondary: ' + tojsononeline(secondaryDoc));
                            var ordering = bsonWoCompare({wrapper: primaryDoc._id},
                                                         {wrapper: secondaryDoc._id});
                            if (ordering === 0) {
                                primaryIndex--;
                                secondaryIndex--;
                            } else if (ordering < 0) {
                                missingOnPrimary.push(tojsononeline(secondaryDoc));
                                secondaryIndex--;
                            } else if (ordering > 0) {
                                missingOnSecondary.push(tojsononeline(primaryDoc));
                                primaryIndex--;
                            }
                        } else {
                            // Latest document matched.
                            primaryIndex--;
                            secondaryIndex--;
                        }
                    }
                }

                if (missingOnPrimary.length) {
                    print('The following documents are missing on the primary:');
                    print(missingOnPrimary.join('\n'));
                }
                if (missingOnSecondary.length) {
                    print('The following documents are missing on the secondary:');
                    print(missingOnSecondary.join('\n'));
                }
            }

            function checkDBHashesForReplSet(rst, dbBlacklist, msgPrefix) {
                // We don't expect the local database to match because some of its
                // collections are not replicated.
                dbBlacklist.push('local');

                var success = true;
                var hasDumpedOplog = false;

                // Use liveNodes.master instead of getPrimary() to avoid the detection
                // of a new primary.
                // liveNodes must have been populated.
                var primary = rst.liveNodes.master;
                var combinedDBs = new Set(primary.getDBNames());

                rst.getSecondaries().forEach(secondary => {
                    secondary.getDBNames().forEach(dbName => combinedDBs.add(dbName));
                });

                for (var dbName of combinedDBs) {
                    if (Array.contains(dbBlacklist, dbName)) {
                        continue;
                    }

                    var dbHashes = rst.getHashes(dbName);
                    var primaryDBHash = dbHashes.master;
                    assert.commandWorked(primaryDBHash);

                    try {
                        var primaryCollInfo = primary.getDB(dbName).getCollectionInfos();
                    } catch (e) {
                        if (jsTest.options().skipValidationOnInvalidViewDefinitions) {
                            assert.commandFailedWithCode(e, ErrorCodes.InvalidViewDefinition);
                            print('Skipping dbhash check on ' + dbName +
                                  ' because of invalid views in system.views');
                            continue;
                        } else {
                            throw e;
                        }
                    }

                    dbHashes.slaves.forEach(secondaryDBHash => {
                        assert.commandWorked(secondaryDBHash);

                        var secondary =
                            rst.liveNodes.slaves.find(node => node.host === secondaryDBHash.host);
                        assert(
                            secondary,
                            'could not find the replica set secondary listed in the dbhash response ' +
                                tojson(secondaryDBHash));

                        var primaryCollections = Object.keys(primaryDBHash.collections);
                        var secondaryCollections = Object.keys(secondaryDBHash.collections);

                        if (primaryCollections.length !== secondaryCollections.length) {
                            print(
                                msgPrefix +
                                ', the primary and secondary have a different number of collections: ' +
                                tojson(dbHashes));
                            for (var diffColl of arraySymmetricDifference(primaryCollections,
                                                                          secondaryCollections)) {
                                dumpCollectionDiff(primary, secondary, dbName, diffColl);
                            }
                            success = false;
                        }

                        var nonCappedCollNames = primaryCollections.filter(
                            collName => !primary.getDB(dbName).getCollection(collName).isCapped());
                        // Only compare the dbhashes of non-capped collections because capped
                        // collections are not necessarily truncated at the same points
                        // across replica set members.
                        nonCappedCollNames.forEach(collName => {
                            if (primaryDBHash.collections[collName] !==
                                secondaryDBHash.collections[collName]) {
                                print(msgPrefix +
                                      ', the primary and secondary have a different hash for the' +
                                      ' collection ' + dbName + '.' + collName + ': ' +
                                      tojson(dbHashes));
                                dumpCollectionDiff(primary, secondary, dbName, collName);
                                success = false;
                            }

                        });

                        // Check that collection information is consistent on the primary and
                        // secondaries.
                        var secondaryCollInfo = secondary.getDB(dbName).getCollectionInfos();
                        secondaryCollInfo.forEach(secondaryInfo => {
                            primaryCollInfo.forEach(primaryInfo => {
                                if (secondaryInfo.name === primaryInfo.name) {
                                    if (!bsonBinaryEqual(secondaryInfo, primaryInfo)) {
                                        print(msgPrefix +
                                              ', the primary and secondary have different ' +
                                              'attributes for the collection ' + dbName + '.' +
                                              secondaryInfo.name);
                                        print('Collection info on the primary: ' +
                                              tojson(primaryInfo));
                                        print('Collection info on the secondary: ' +
                                              tojson(secondaryInfo));
                                        success = false;
                                    }
                                }
                            });
                        });

                        // Check that the following collection stats are the same across replica set
                        // members:
                        //  capped
                        //  nindexes
                        //  ns
                        primaryCollections.forEach(collName => {
                            var primaryCollStats =
                                primary.getDB(dbName).runCommand({collStats: collName});
                            assert.commandWorked(primaryCollStats);
                            var secondaryCollStats =
                                secondary.getDB(dbName).runCommand({collStats: collName});
                            assert.commandWorked(secondaryCollStats);

                            if (primaryCollStats.capped !== secondaryCollStats.capped ||
                                primaryCollStats.nindexes !== secondaryCollStats.nindexes ||
                                primaryCollStats.ns !== secondaryCollStats.ns) {
                                print(msgPrefix +
                                      ', the primary and secondary have different stats for the ' +
                                      'collection ' + dbName + '.' + collName);
                                print('Collection stats on the primary: ' +
                                      tojson(primaryCollStats));
                                print('Collection stats on the secondary: ' +
                                      tojson(secondaryCollStats));
                                success = false;
                            }
                        });

                        if (nonCappedCollNames.length === primaryCollections.length) {
                            // If the primary and secondary have the same hashes for all the
                            // collections in the database and there aren't any capped collections,
                            // then the hashes for the whole database should match.
                            if (primaryDBHash.md5 !== secondaryDBHash.md5) {
                                print(msgPrefix +
                                      ', the primary and secondary have a different hash for ' +
                                      'the ' + dbName + ' database: ' + tojson(dbHashes));
                                success = false;
                            }
                        }

                        if (!success) {
                            if (!hasDumpedOplog) {
                                rst.dumpOplog(primary, 100);
                                rst.getSecondaries().forEach(secondary =>
                                                                 rst.dumpOplog(secondary, 100));
                                hasDumpedOplog = true;
                            }
                        }
                    });
                }

                assert(success, 'dbhash mismatch between primary and secondary');
            }

            // Call getPrimary to populate rst with information about the nodes.
            var primary = rst.getPrimary();
            assert(primary, 'calling getPrimary() failed');

            // Since we cannot determine if there is a background index in progress (SERVER-25176),
            // we flush indexing as follows:
            //  1. Create a foreground index on a dummy collection/database
            //  2. Insert a document into the dummy collection with a writeConcern for all nodes
            //  3. Drop the dummy database
            var dbNames = new Set(primary.getDBNames());
            var uniqueDbName = generateUniqueDbName(dbNames, "flush_all_background_indexes_");

            var dummyDB = primary.getDB(uniqueDbName);
            var dummyColl = dummyDB.dummy;
            dummyColl.drop();
            assert.commandWorked(dummyColl.createIndex({x: 1}));
            assert.writeOK(dummyColl.insert(
                {x: 1},
                {writeConcern: {w: rst.nodeList().length, wtimeout: self.kDefaultTimeoutMS}}));
            assert.commandWorked(dummyDB.dropDatabase());

            var activeException = false;

            try {
                // Lock the primary to prevent the TTL monitor from deleting expired documents in
                // the background while we are getting the dbhashes of the replica set members.
                assert.commandWorked(primary.adminCommand({fsync: 1, lock: 1}),
                                     'failed to lock the primary');
                rst.awaitReplication(60 * 1000 * 5);
                checkDBHashesForReplSet(rst, dbBlacklist, msgPrefix);
            } catch (e) {
                activeException = true;
                throw e;
            } finally {
                // Allow writes on the primary.
                var res = primary.adminCommand({fsyncUnlock: 1});

                if (!res.ok) {
                    var msg = 'failed to unlock the primary, which may cause this' +
                        ' test to hang: ' + tojson(res);
                    if (activeException) {
                        print(msg);
                    } else {
                        throw new Error(msg);
                    }
                }
            }
        }

        checkDBHashes(this, excludedDBs, msgPrefix);
    };

    /**
     * Starts up a server.  Options are saved by default for subsequent starts.
     *
     *
     * Options { remember : true } re-applies the saved options from a prior start.
     * Options { noRemember : true } ignores the current properties.
     * Options { appendOptions : true } appends the current options to those remembered.
     * Options { startClean : true } clears the data directory before starting.
     *
     * @param {int|conn|[int|conn]} n array or single server number (0, 1, 2, ...) or conn
     * @param {object} [options]
     * @param {boolean} [restart] If false, the data directory will be cleared
     *   before the server starts.  Default: false.
     *
     */
    this.start = function(n, options, restart, wait) {
        if (n.length) {
            var nodes = n;
            var started = [];

            for (var i = 0; i < nodes.length; i++) {
                if (this.start(nodes[i], Object.merge({}, options), restart, wait)) {
                    started.push(nodes[i]);
                }
            }

            return started;
        }

        // TODO: should we do something special if we don't currently know about this node?
        n = this.getNodeId(n);

        print("ReplSetTest n is : " + n);

        var defaults = {
            useHostName: this.useHostName,
            oplogSize: this.oplogSize,
            keyFile: this.keyFile,
            port: _useBridge ? _unbridgedPorts[n] : this.ports[n],
            noprealloc: "",
            smallfiles: "",
            replSet: this.useSeedList ? this.getURL() : this.name,
            dbpath: "$set-$node"
        };

        //
        // Note : this replaces the binVersion of the shared startSet() options the first time
        // through, so the full set is guaranteed to have different versions if size > 1.  If using
        // start() independently, independent version choices will be made
        //
        if (options && options.binVersion) {
            options.binVersion = MongoRunner.versionIterator(options.binVersion);
        }

        // If restarting a node, use its existing options as the defaults.
        if ((options && options.restart) || restart) {
            options = Object.merge(this.nodes[n].fullOptions, options);
        } else {
            options = Object.merge(defaults, options);
        }
        options = Object.merge(options, this.nodeOptions["n" + n]);
        delete options.rsConfig;

        options.restart = options.restart || restart;

        var pathOpts = {node: n, set: this.name};
        options.pathOpts = Object.merge(options.pathOpts || {}, pathOpts);

        // Turn off periodic noop writes for replica sets by default.
        options.setParameter = options.setParameter || {};
        options.setParameter.writePeriodicNoops = options.setParameter.writePeriodicNoops || false;
        options.setParameter.numInitialSyncAttempts =
            options.setParameter.numInitialSyncAttempts || 1;
        // We raise the number of initial sync connect attempts for tests that disallow chaining.
        // Disabling chaining can cause sync source selection to take longer so we must increase
        // the number of connection attempts.
        options.setParameter.numInitialSyncConnectAttempts =
            options.setParameter.numInitialSyncConnectAttempts || 60;

        if (tojson(options) != tojson({}))
            printjson(options);

        print("ReplSetTest " + (restart ? "(Re)" : "") + "Starting....");

        if (_useBridge) {
            var bridgeOptions = Object.merge(_bridgeOptions, options.bridgeOptions || {});
            bridgeOptions = Object.merge(bridgeOptions, {
                hostName: this.host,
                port: this.ports[n],
                // The mongod processes identify themselves to mongobridge as host:port, where the
                // host is the actual hostname of the machine and not localhost.
                dest: getHostName() + ":" + _unbridgedPorts[n],
            });

            if (jsTestOptions().networkMessageCompressors) {
                bridgeOptions["networkMessageCompressors"] =
                    jsTestOptions().networkMessageCompressors;
            }

            this.nodes[n] = new MongoBridge(bridgeOptions);
        }

        var conn = MongoRunner.runMongod(options);
        if (!conn) {
            throw new Error("Failed to start node " + n);
        }

        // Make sure to call _addPath, otherwise folders won't be cleaned.
        this._addPath(conn.dbpath);

        if (_useBridge) {
            this.nodes[n].connectToBridge();
            _unbridgedNodes[n] = conn;
        } else {
            this.nodes[n] = conn;
        }

        // Add replica set specific attributes.
        this.nodes[n].nodeId = n;

        printjson(this.nodes);

        // Clean up after noReplSet to ensure it doesn't effect future restarts.
        if (options.noReplSet) {
            this.nodes[n].fullOptions.replSet = defaults.replSet;
            delete this.nodes[n].fullOptions.noReplSet;
        }

        wait = wait || false;
        if (!wait.toFixed) {
            if (wait)
                wait = 0;
            else
                wait = -1;
        }

        if (wait >= 0) {
            // Wait for node to start up.
            _waitForHealth(this.nodes[n], Health.UP, wait);
        }

        return this.nodes[n];
    };

    /**
     * Restarts a db without clearing the data directory by default, and using the node(s)'s
     * original startup options by default.
     *
     * Option { startClean : true } forces clearing the data directory.
     * Option { auth : Object } object that contains the auth details for admin credentials.
     *   Should contain the fields 'user' and 'pwd'
     *
     * In order not to use the original startup options, use stop() (or stopSet()) followed by
     * start() (or startSet()) without passing restart: true as part of the options.
     *
     * @param {int|conn|[int|conn]} n array or single server number (0, 1, 2, ...) or conn
     */
    this.restart = function(n, options, signal, wait) {
        // Can specify wait as third parameter, if using default signal
        if (signal == true || signal == false) {
            wait = signal;
            signal = undefined;
        }

        this.stop(n, signal, options);

        var started = this.start(n, options, true, wait);

        if (jsTestOptions().keyFile) {
            if (started.length) {
                // if n was an array of conns, start will return an array of connections
                for (var i = 0; i < started.length; i++) {
                    assert(jsTest.authenticate(started[i]), "Failed authentication during restart");
                }
            } else {
                assert(jsTest.authenticate(started), "Failed authentication during restart");
            }
        }
        return started;
    };

    this.stopMaster = function(signal, opts) {
        var master = this.getPrimary();
        var master_id = this.getNodeId(master);
        return this.stop(master_id, signal, opts);
    };

    /**
     * Stops a particular node or nodes, specified by conn or id
     *
     * @param {number|Mongo} n the index or connection object of the replica set member to stop.
     * @param {number} signal the signal number to use for killing
     * @param {Object} opts @see MongoRunner.stopMongod
     */
    this.stop = function(n, signal, opts) {
        // Flatten array of nodes to stop
        if (n.length) {
            var nodes = n;

            var stopped = [];
            for (var i = 0; i < nodes.length; i++) {
                if (this.stop(nodes[i], signal, opts))
                    stopped.push(nodes[i]);
            }

            return stopped;
        }

        // Can specify wait as second parameter, if using default signal
        if (signal == true || signal == false) {
            signal = undefined;
        }

        n = this.getNodeId(n);

        var port = _useBridge ? _unbridgedPorts[n] : this.ports[n];
        print('ReplSetTest stop *** Shutting down mongod in port ' + port + ' ***');
        var ret = MongoRunner.stopMongod(port, signal, opts);

        print('ReplSetTest stop *** Mongod in port ' + port + ' shutdown with code (' + ret +
              ') ***');

        if (_useBridge) {
            this.nodes[n].stop();
        }

        return ret;
    };

    /**
     * Kill all members of this replica set.
     *
     * @param {number} signal The signal number to use for killing the members
     * @param {boolean} forRestart will not cleanup data directory
     * @param {Object} opts @see MongoRunner.stopMongod
     */
    this.stopSet = function(signal, forRestart, opts) {
        for (var i = 0; i < this.ports.length; i++) {
            this.stop(i, signal, opts);
        }

        if (forRestart) {
            return;
        }

        if (_alldbpaths) {
            print("ReplSetTest stopSet deleting all dbpaths");
            for (var i = 0; i < _alldbpaths.length; i++) {
                resetDbpath(_alldbpaths[i]);
            }
        }

        _forgetReplSet(this.name);

        print('ReplSetTest stopSet *** Shut down repl set - test worked ****');
    };

    /**
     * Walks all oplogs and ensures matching entries.
     */
    this.ensureOplogsMatch = function() {
        var OplogReader = function(mongo) {
            this.next = function() {
                if (!this.cursor)
                    throw Error("reader is not open!");

                var nextDoc = this.cursor.next();
                if (nextDoc)
                    this.lastDoc = nextDoc;
                return nextDoc;
            };

            this.getLastDoc = function() {
                if (this.lastDoc)
                    return this.lastDoc;
                return this.next();
            };

            this.hasNext = function() {
                if (!this.cursor)
                    throw Error("reader is not open!");
                return this.cursor.hasNext();
            };

            this.query = function(ts) {
                var coll = this.getOplogColl();
                var query = {"ts": {"$gte": ts ? ts : new Timestamp()}};
                this.cursor = coll.find(query).sort({$natural: 1});
                this.cursor.addOption(DBQuery.Option.oplogReplay);
            };

            this.getFirstDoc = function() {
                return this.getOplogColl().find().sort({$natural: 1}).limit(-1).next();
            };

            this.getOplogColl = function() {
                return this.mongo.getDB("local")["oplog.rs"];
            };

            this.lastDoc = null;
            this.cursor = null;
            this.mongo = mongo;
        };

        if (this.nodes.length && this.nodes.length > 1) {
            var readers = [];
            var largestTS = null;
            var nodes = this.nodes;
            var rsSize = nodes.length;
            for (var i = 0; i < rsSize; i++) {
                readers[i] = new OplogReader(nodes[i]);
                var currTS = readers[i].getFirstDoc().ts;
                if (currTS.t > largestTS.t || (currTS.t == largestTS.t && currTS.i > largestTS.i)) {
                    largestTS = currTS;
                }
            }

            // start all oplogReaders at the same place.
            for (i = 0; i < rsSize; i++) {
                readers[i].query(largestTS);
            }

            var firstReader = readers[0];
            while (firstReader.hasNext()) {
                var ts = firstReader.next().ts;
                for (i = 1; i < rsSize; i++) {
                    assert.eq(
                        ts, readers[i].next().ts, " non-matching ts for node: " + readers[i].mongo);
                }
            }

            // ensure no other node has more oplog
            for (i = 1; i < rsSize; i++) {
                assert.eq(
                    false, readers[i].hasNext(), "" + readers[i] + " shouldn't have more oplog.");
            }
        }
    };

    /**
     * Wait for a state indicator to go to a particular state or states.
     *
     * @param node is a single node or list of nodes, by id or conn
     * @param state is a single state or list of states
     *
     */
    this.waitForState = function(node, state, timeout) {
        _waitForIndicator(node, state, "state", timeout);
    };

    /**
     * Waits until there is a master node.
     */
    this.waitForMaster = function(timeout) {
        var master;
        assert.soonNoExcept(function() {
            return (master = self.getPrimary());
        }, "waiting for master", timeout);

        return master;
    };

    //
    // ReplSetTest constructors
    //

    /**
     * Constructor, which initializes the ReplSetTest object by starting new instances.
     */
    function _constructStartNewInstances(opts) {
        self.name = opts.name || "testReplSet";
        print('Starting new replica set ' + self.name);

        self.useHostName = opts.useHostName == undefined ? true : opts.useHostName;
        self.host = self.useHostName ? (opts.host || getHostName()) : 'localhost';
        self.oplogSize = opts.oplogSize || 40;
        self.useSeedList = opts.useSeedList || false;
        self.keyFile = opts.keyFile;
        self.protocolVersion = opts.protocolVersion;

        _useBridge = opts.useBridge || false;
        _bridgeOptions = opts.bridgeOptions || {};

        _configSettings = opts.settings || false;

        self.nodeOptions = {};

        var numNodes;

        if (isObject(opts.nodes)) {
            var len = 0;
            for (var i in opts.nodes) {
                var options = self.nodeOptions["n" + len] =
                    Object.merge(opts.nodeOptions, opts.nodes[i]);
                if (i.startsWith("a")) {
                    options.arbiter = true;
                }

                len++;
            }

            numNodes = len;
        } else if (Array.isArray(opts.nodes)) {
            for (var i = 0; i < opts.nodes.length; i++) {
                self.nodeOptions["n" + i] = Object.merge(opts.nodeOptions, opts.nodes[i]);
            }

            numNodes = opts.nodes.length;
        } else {
            for (var i = 0; i < opts.nodes; i++) {
                self.nodeOptions["n" + i] = opts.nodeOptions;
            }

            numNodes = opts.nodes;
        }

        self.ports = allocatePorts(numNodes);
        self.nodes = [];

        if (_useBridge) {
            _unbridgedPorts = allocatePorts(numNodes);
            _unbridgedNodes = [];
        }
    }

    /**
     * Constructor, which instantiates the ReplSetTest object from an existing set.
     */
    function _constructFromExistingSeedNode(seedNode) {
        var conf = _replSetGetConfig(new Mongo(seedNode));
        print('Recreating replica set from config ' + tojson(conf));

        var existingNodes = conf.members.map(member => member.host);
        self.ports = existingNodes.map(node => node.split(':')[1]);
        self.nodes = existingNodes.map(node => new Mongo(node));
    }

    if (typeof opts === 'string' || opts instanceof String) {
        _constructFromExistingSeedNode(opts);
    } else {
        _constructStartNewInstances(opts);
    }
};

/**
 * Set of states that the replica set can be in. Used for the wait functions.
 */
ReplSetTest.State = {
    PRIMARY: 1,
    SECONDARY: 2,
    RECOVERING: 3,
    // Note there is no state 4
    STARTUP_2: 5,
    UNKNOWN: 6,
    ARBITER: 7,
    DOWN: 8,
    ROLLBACK: 9,
    REMOVED: 10,
};

ReplSetTest.OpTimeType = {
    LAST_APPLIED: 1,
    LAST_DURABLE: 2,
};

/**
 * Waits for the specified hosts to enter a certain state.
 */
ReplSetTest.awaitRSClientHosts = function(conn, host, hostOk, rs, timeout) {
    var hostCount = host.length;
    if (hostCount) {
        for (var i = 0; i < hostCount; i++) {
            ReplSetTest.awaitRSClientHosts(conn, host[i], hostOk, rs);
        }

        return;
    }

    timeout = timeout || 5 * 60 * 1000;

    if (hostOk == undefined)
        hostOk = {ok: true};
    if (host.host)
        host = host.host;
    if (rs)
        rs = rs.name;

    print("Awaiting " + host + " to be " + tojson(hostOk) + " for " + conn + " (rs: " + rs + ")");

    var tests = 0;

    assert.soon(function() {
        var rsClientHosts = conn.adminCommand('connPoolStats').replicaSets;
        if (tests++ % 10 == 0) {
            printjson(rsClientHosts);
        }

        for (var rsName in rsClientHosts) {
            if (rs && rs != rsName)
                continue;

            for (var i = 0; i < rsClientHosts[rsName].hosts.length; i++) {
                var clientHost = rsClientHosts[rsName].hosts[i];
                if (clientHost.addr != host)
                    continue;

                // Check that *all* host properties are set correctly
                var propOk = true;
                for (var prop in hostOk) {
                    // Use special comparator for tags because isMaster can return the fields in
                    // different order. The fields of the tags should be treated like a set of
                    // strings and 2 tags should be considered the same if the set is equal.
                    if (prop == 'tags') {
                        if (!clientHost.tags) {
                            propOk = false;
                            break;
                        }

                        for (var hostTag in hostOk.tags) {
                            if (clientHost.tags[hostTag] != hostOk.tags[hostTag]) {
                                propOk = false;
                                break;
                            }
                        }

                        for (var clientTag in clientHost.tags) {
                            if (clientHost.tags[clientTag] != hostOk.tags[clientTag]) {
                                propOk = false;
                                break;
                            }
                        }

                        continue;
                    }

                    if (isObject(hostOk[prop])) {
                        if (!friendlyEqual(hostOk[prop], clientHost[prop])) {
                            propOk = false;
                            break;
                        }
                    } else if (clientHost[prop] != hostOk[prop]) {
                        propOk = false;
                        break;
                    }
                }

                if (propOk) {
                    return true;
                }
            }
        }

        return false;
    }, 'timed out waiting for replica set client to recognize hosts', timeout);
};
