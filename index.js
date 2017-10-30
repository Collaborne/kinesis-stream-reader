const _ = require('lodash');

/**
 * Interval in miliseconds to poll Kinesis for new messages
 */
const POLL_INTERVAL = 1000;

/**
 * Consume events from a Kinesis stream.
 */
class KinesisStreamReader { // eslint-disable-line padded-blocks

	/**
	 * Creates an instance of KinesisStreamReader
	 *
	 * @param {Function} eventHandler Function that is called for each received event
	 * @param {Object} kinesis Reference to AWS kinesis object
	 */
	constructor(eventHandler, kinesis) {
		this.eventHandler = eventHandler;
		this.kinesis = kinesis;
		this.lastSeqNo = undefined;
	}

	/**
	 * Starts consuming events from all input streams
	 *
	 * @param {String} streamName Names of the input stream
	 * @return {Promise} Promise
	 */
	start(streamName) {
		return this.getShards(streamName)
			.then(shards => {
				shards.forEach(shard => {
					this.infiniteGetIterator(streamName, shard.ShardId);
				});
			});
	}

	/**
	 * Finds all shared of a stream
	 *
	 * @param {string} streamName Name of the Kinesis stream
	 * @returns {Promise} Resolves to Shard objects
	 */
	getShards(streamName) {
		return this.kinesis.describeStream({
			StreamName: streamName,
		}).promise()
			.then(streamData => {
				const streamStatus = streamData.StreamDescription.StreamStatus;
				if (streamStatus === 'ACTIVE') {
					return streamData.StreamDescription.Shards;
				}
				// Recursively resolve the promise until the stream has ACTIVE status
				return this.getShards(streamName);
			});
	}

	/**
	 * Continously reads records from a shard. The iterator is automatically renewed.
	 *
	 * @param {string} streamName Name of the Kinesis stream
	 * @param {string} shardId ID of the Kinesis shard
	 * @returns {void}
	 */
	infiniteGetIterator(streamName, shardId) {
		this.getIterator(streamName, shardId, this.lastSeqNo)
			.then(shardIterator => this.infiniteGetRecords(shardIterator))
			.catch(err => {
				// If iterator is expired, get a new one
				if (err.code === 'ExpiredIteratorException') {
					this.infiniteGetIterator(streamName, shardId);
				} else {
					console.warn(`${streamName}: Iterator failed: ${JSON.stringify(err)}`);

					// Keep promise in reject state
					throw err;
				}
			});
	}

	/**
	 * Creates an iterator reading from the latest - or optionally
	 * from a specific sequence number
	 *
	 * @param {string} streamName Name of the Kinesis stream
	 * @param {string} shardId ID of the Kinesis shard
	 * @param {string} lastSeqNo (Optional) last sequence number from where to read
	 * @returns {Promise} Resolves to Kinesis iterator
	 */
	getIterator(streamName, shardId, lastSeqNo) {
		const params = {
			ShardId: shardId,
			ShardIteratorType: 'LATEST',
			StreamName: streamName,
		};
		if (lastSeqNo) {
			Object.assign(params, {
				ShardIteratorType: 'AFTER_SEQUENCE_NUMBER',
				StartingSequenceNumber: lastSeqNo,
			});
		}
		return this.kinesis.getShardIterator(params).promise()
			.then(shardIteratordata => {
				console.log(`${streamName}: New iterator is ${shardIteratordata.ShardIterator} (starting at ${lastSeqNo})`);
				return shardIteratordata.ShardIterator;
			});
	}

	/**
	 * Reads records from a Kinesis iterator
	 *
	 * @param {Object} iterator Kinesis iterator
	 * @returns {Promise} Promise
	 */
	infiniteGetRecords(iterator) {
		return new Promise(function getRecords(resolve, reject) {
			this.kinesis.getRecords({
				ShardIterator: iterator
			}).promise()
				.then(recordsData => {
					// To prevent ProvisionedThroughputExceededException, wait 1 second between getRecords
					setTimeout(() => {
						// If process found records
						if (recordsData.Records.length > 0) {
							this.handleRecords(recordsData);
						}

						// Recursively resolve the promise passing next iterator for the shard
						resolve(this.infiniteGetRecords(recordsData.NextShardIterator));
					}, POLL_INTERVAL);
				})
				.catch(err => {
					reject(err);
				});
		}.bind(this));
	}

	/**
	 * Extracts data from received Kinesis records and call the event handler
	 *
	 * @param {Object} recordsData Received Kinesis records
	 * @returns {void}
	 */
	handleRecords(recordsData) {
		for (const record of recordsData.Records) {
			const stringData = new Buffer(record.Data, 'base64').toString();
			const event = JSON.parse(stringData);
			const isRejected = _.get(event, 'is_rejected', false);
			if (!isRejected) {
				this.eventHandler(event);
			}
		}
		// Save sequence number of the last record read
		// so next iterator will start from here
		const lastRecord = _.last(recordsData.Records);
		this.lastSeqNo = _.get(lastRecord, 'SequenceNumber');
	}
}

module.exports = KinesisStreamReader;
