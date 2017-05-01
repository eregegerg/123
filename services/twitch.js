/**
 * Created by Anton on 06.12.2015.
 */
"use strict";
const debug = require('debug')('app:twitch');
const base = require('../base');
const requestPromise = require('request-promise');
const CustomError = require('../customError').CustomError;

var Twitch = function(options) {
    this.super(options);
    this.name = 'twitch';
    this.config = {
        token: options.config.twitchToken
    };
};

Twitch.prototype = Object.create(require('./service').prototype);
Twitch.prototype.constructor = Twitch;

Twitch.prototype.isServiceUrl = function (url) {
    return [
        /twitch\.tv\//i
    ].some(function (re) {
        return re.test(url);
    });
};

Twitch.prototype.getChannelUrl = function (channelName) {
    return 'https://twitch.tv/' + channelName;
};

Twitch.prototype.insertItem = function (channel, stream) {
    var _this = this;
    return Promise.resolve().then(function () {
        var id = stream._id;
        var viewers = parseInt(stream.viewers) || 0;
        var game = stream.game;
        var createdAt = stream.created_at;
        var channelTitle = stream.channel.display_name;
        var channelName = stream.channel.name;

        var previewList = [];
        stream.preview && ['template', 'large', 'medium'].forEach(function(quality) {
            var url = stream.preview[quality];
            if (url) {
                if (quality === 'template') {
                    url = url.replace('{width}', '1280').replace('{height}', '720');
                }

                previewList.push(url);
            }
        });
        previewList = previewList.map(base.noCacheUrl);

        var data = {
            service: _this.name,
            _id: _this.channels.wrapId(id, _this.name),
            _channelId: channel.id,

            viewers: viewers,
            game: game,
            preview: previewList,
            created_at: createdAt,
            channel: {
                name: channelTitle || channelName,
                status: stream.channel.status,
                url: stream.channel.url
            }
        };

        var item = {
            id: _this.channels.wrapId(id, _this.name),
            channelId: channel.id,
            data: JSON.stringify(data),
            checkTime: base.getNow(),
            isOffline: 0,
            isTimeout: 0
        };

        var channelUrl = _this.getChannelUrl(stream.channel.name);

        var promise = Promise.resolve();
        if (channel.title !== data.channel.name || channel.url !== channelUrl) {
            promise = promise.then(function () {
                channel.title = data.channel.name;
                channel.url = channelUrl;
                return _this.channels.updateChannel(channel.id, {
                    title: channel.title,
                    url: channel.url
                });
            });
        }

        return promise.then(function () {
            return item;
        });
    });
};

Twitch.prototype.getStreamList = function(_channelList) {
    var _this = this;
    var videoList = [];

    var promise = Promise.resolve(_channelList);

    promise = promise.then(function (channels) {
        if (!channels.length) return;

        var queue = Promise.resolve();

        base.arrToParts(channels, 100).forEach(function (channelsPart) {
            var channelIdMap = {};
            channelsPart.forEach(function (channel) {
                var id = _this.channels.unWrapId(channel.id);
                channelIdMap[id] = channel;
            });

            queue = queue.then(function () {
                var retryLimit = 1;
                var getList = function () {
                    return requestPromise({
                        method: 'GET',
                        url: 'https://api.twitch.tv/kraken/streams',
                        qs: {
                            limit: 100,
                            channel: Object.keys(channelIdMap).join(','),
                            stream_type: 'live'
                        },
                        headers: {
                            'Accept': 'application/vnd.twitchtv.v5+json',
                            'Client-ID': _this.config.token
                        },
                        json: true,
                        gzip: true,
                        forever: true
                    }).then(function (responseBody) {
                        if (!Array.isArray(responseBody.streams)) {
                            var err = new Error('Unexpected response');
                            err.channelIdMap = channelIdMap;
                            err.responseBody = responseBody;
                            throw err;
                        }

                        return responseBody;
                    }).catch(function (err) {
                        if (retryLimit-- < 1) {
                            throw err;
                        }

                        return new Promise(function(resolve) {
                            return setTimeout(resolve, 250);
                        }).then(function() {
                            // debug("Retry %s getList", retryLimit, err);
                            return getList();
                        });
                    });
                };

                return getList().then(function (responseBody) {
                    var items = responseBody.streams;

                    return insertPool.do(function () {
                        var stream = items.shift();
                        if (!stream) return;

                        return Promise.resolve().then(function () {
                            var channel = channelIdMap[stream.channel._id];
                            if (!channel) {
                                var err = new Error('Channel is not found!');
                                err.stream = stream;
                                throw err;
                            }

                            return _this.insertItem(channel, stream).then(function (item) {
                                item && videoList.push(item);
                            }).catch(function (err) {
                                videoList.push(base.getTimeoutStream(channel));
                                throw err;
                            });
                        }).catch(function (err) {
                            debug("insertItem error!", err);
                        });
                    });
                }).catch(function (err) {
                    channelsPart.forEach(function (channel) {
                        videoList.push(base.getTimeoutStream(channel));
                    });
                    debug("Request stream list error!", err);
                });
            });
        });

        return queue;
    });

    return promise.then(function () {
        return videoList;
    });
};

var insertPool = new base.Pool(15);

Twitch.prototype.requestChannelByName = function (channelName) {
    var _this = this;
    return requestPromise({
        method: 'GET',
        url: 'https://api.twitch.tv/kraken/search/channels',
        qs: {
            query: channelName,
            limit: 1
        },
        headers: {
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Client-ID': _this.config.token
        },
        json: true,
        gzip: true,
        forever: true
    }).then(function(responseBody) {
        var channel = null;
        responseBody.channels.some(function (item) {
            return channel = item;
        });
        if (!channel) {
            throw new CustomError('Channel is not found by name!');
        }
        return channel;
    });
};

Twitch.prototype.getChannelNameByUrl = function (url) {
    var channelId = '';
    [
        /twitch\.tv\/([\w\-]+)/i
    ].some(function (re) {
        var m = re.exec(url);
        if (m) {
            channelId = m[1];
            return true;
        }
    });
    if (!channelId) {
        return Promise.reject(new CustomError("Is not channel url!"));
    } else {
        return Promise.resolve(channelId);
    }
};

Twitch.prototype.getChannelId = function(channelName) {
    var _this = this;

    return _this.getChannelNameByUrl(channelName).catch(function (err) {
        if (!(err instanceof CustomError)) {
            throw err;
        }

        return channelName;
    }).then(function (channelName) {
        return _this.requestChannelByName(channelName).then(function (streamChannel) {
            var id = streamChannel._id;
            var title = streamChannel.display_name || streamChannel.name;
            var url = _this.getChannelUrl(streamChannel.name);

            return _this.channels.insertChannel(id, _this.name, title, url);
        });
    });
};

module.exports = Twitch;