/**
 * Created by Anton on 06.12.2015.
 */
"use strict";
var debug = require('debug')('app:hitbox');
var base = require('../base');
var Promise = require('bluebird');
var request = require('request');
var requestPromise = require('request-promise');
var CustomError = require('../customError').CustomError;

var Hitbox = function(options) {
    var _this = this;
    this.gOptions = options;
    this.config = {};

    this.onReady = _this.init();
};

Hitbox.prototype.init = function () {
    var _this = this;
    var db = this.gOptions.db;
    var promise = Promise.resolve();
    promise = promise.then(function () {
        return new Promise(function (resolve, reject) {
            db.connection.query('\
            CREATE TABLE IF NOT EXISTS `hbChannels` ( \
                `id` VARCHAR(191) CHARACTER SET utf8mb4 NOT NULL, \
                `title` TEXT CHARACTER SET utf8mb4 NULL, \
            UNIQUE INDEX `id_UNIQUE` (`id` ASC)); \
        ', function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    });
    promise = promise.then(function () {
        return _this.migrate();
    });
    return promise;
};

Hitbox.prototype.migrate = function () {
    var _this = this;
    var db = this.gOptions.db;

    return base.storage.get(['hitboxChannelInfo']).then(function(storage) {
        var channelInfo = storage.hitboxChannelInfo || {};

        var channels = Object.keys(channelInfo);
        var threadCount = 100;
        var partSize = Math.ceil(channels.length / threadCount);

        var migrateChannel = function (connection, channelId, data) {
            var info = {
                id: channelId,
                title: data.title
            };
            return new Promise(function (resolve, reject) {
                connection.query('\
                    INSERT INTO hbChannels SET ? ON DUPLICATE KEY UPDATE id = id \
                ', info, function (err, results) {
                    if (err) {
                        if (err.code === 'ER_DUP_ENTRY') {
                            resolve();
                        } else {
                            reject(err);
                        }
                    } else {
                        resolve();
                    }
                });
            }).catch(function (err) {
                debug('Migrate', err);
            });
        };

        return Promise.all(base.arrToParts(channels, partSize).map(function (arr) {
            return base.arrayToChainPromise(arr, function (channelId) {
                return db.newConnection().then(function (connection) {
                    return migrateChannel(connection, channelId, channelInfo[channelId]).then(function () {
                        connection.end();
                    });
                });
            });
        }));
    });
};

/**
 * @typedef {{}} ChannelInfo
 * @property {String} id
 * @property {String} title
 */

/**
 * @private
 * @param {String} channelId
 * @return {Promise}
 */
Hitbox.prototype.getChannelInfo = function (channelId) {
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            SELECT * FROM hbChannels WHERE id = ? LIMIT 1 \
        ', [channelId], function (err, results) {
            if (err) {
                reject(err);
            } else {
                resolve(results[0] || {});
            }
        });
    }).catch(function (err) {
        debug('getChannelInfo', err);
        return {};
    });
};

/**
 * @param {ChannelInfo} info
 * @return {String}
 */
var getChannelTitleFromInfo = function (info) {
    return info.title || info.id;
};

Hitbox.prototype.getChannelTitle = function (channelId) {
    return this.getChannelInfo(channelId).then(function (info) {
        return getChannelTitleFromInfo(info) || channelId;
    });
};

/**
 * @param {Object} info
 * @return {Promise}
 */
Hitbox.prototype.setChannelInfo = function(info) {
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            INSERT INTO hbChannels SET ? ON DUPLICATE KEY UPDATE ? \
        ', [info, info], function (err, results) {
            if (err) {
                debug('setChannelInfo', err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

Hitbox.prototype.clean = function(channelIdList) {
    // todo: fix me
    return Promise.resolve();
    /*var _this = this;
    var promiseList = [];

    var needSaveState = false;
    var channelInfo = _this.config.channelInfo;
    Object.keys(channelInfo).forEach(function (channelId) {
        if (channelIdList.indexOf(channelId) === -1) {
            delete channelInfo[channelId];
            needSaveState = true;
            // debug('Removed from channelInfo %s', channelId);
        }
    });

    if (needSaveState) {
        promiseList.push(_this.saveChannelInfo());
    }

    return Promise.all(promiseList);*/
};

Hitbox.prototype.apiNormalization = function(data) {
    var _this = this;

    var now = base.getNow();
    var streamArray = [];
    data.livestream.forEach(function(origItem) {
        if (!origItem.channel || !origItem.channel.user_name || !origItem.media_id) {
            debug('Item without name! %j', origItem);
            return;
        }

        if (origItem.media_is_live < 1) {
            return;
        }

        var channelId = origItem.channel.user_name.toLowerCase();

        var previewList = [];
        if (origItem.media_thumbnail_large) {
            previewList.push(origItem.media_thumbnail_large);
        } else
        if (origItem.media_thumbnail) {
            previewList.push(origItem.media_thumbnail);
        }
        previewList = previewList.map(function(path) {
            var url = 'http://edge.sf.hitbox.tv' + path;
            return base.noCacheUrl(url);
        });

        var item = {
            _service: 'hitbox',
            _checkTime: now,
            _insertTime: now,
            _id: 'h' + origItem.media_id,
            _isOffline: false,
            _isTimeout: false,
            _channelId: channelId,

            viewers: parseInt(origItem.media_views) || 0,
            game: origItem.category_name,
            preview: previewList,
            created_at: origItem.media_live_since,
            channel: {
                display_name: origItem.media_display_name,
                name: origItem.media_user_name,
                status: origItem.media_status,
                url: origItem.channel.channel_link
            }
        };

        // _this.setChannelTitle(channelId, origItem.media_display_name);

        streamArray.push(item);
    });

    return streamArray;
};

Hitbox.prototype.getStreamList = function(channelList) {
    var _this = this;
    var videoList = [];

    var promiseList = base.arrToParts(channelList, 100).map(function (arr) {
        var channels = arr.map(function(item) {
            return encodeURIComponent(item);
        }).join(',');

        var retryLimit = 5;
        var getList = function () {
            return requestPromise({
                method: 'GET',
                url: 'https://api.hitbox.tv/media/live/' + channels,
                qs: {
                    showHidden: 'true'
                },
                json: true,
                gzip: true,
                forever: true
            }).catch(function (err) {
                if (retryLimit-- < 1) {
                    throw err;
                }

                return new Promise(function (resolve) {
                    return setTimeout(resolve, 250);
                }).then(function () {
                    // debug("Retry %s getList", retryLimit, err);
                    return getList();
                });
            });
        };

        return getList().then(function (responseBody) {
            try {
                var list = _this.apiNormalization(responseBody);
                videoList.push.apply(videoList, list);
            } catch (e) {
                debug('Unexpected response %j', responseBody, e);
                throw new CustomError('Unexpected response');
            }
        }).catch(function (err) {
            arr.forEach(function (channelId) {
                videoList.push(base.getTimeoutStream('hitbox', channelId));
            });
            debug("Request stream list error!", err);
        });
    });

    return Promise.all(promiseList).then(function () {
        return videoList;
    });
};

Hitbox.prototype.getChannelId = function(channelName) {
    var _this = this;
    return requestPromise({
        method: 'GET',
        url: 'https://api.hitbox.tv/media/live/' + encodeURIComponent(channelName),
        qs: {
            showHidden: 'true'
        },
        json: true,
        gzip: true,
        forever: true
    }).then(function(responseBody) {
        var stream = null;
        responseBody.livestream.some(function(item) {
            if (item.channel && item.channel.user_name) {
                return stream = item;
            }
        });
        if (!stream) {
            throw new CustomError('Channel is not found!');
        }

        var username = stream.channel.user_name.toLowerCase();
        var title = stream.media_display_name;

        return _this.setChannelInfo({
            id: username,
            title: title
        }).then(function () {
            return username;
        });
    });
};

module.exports = Hitbox;