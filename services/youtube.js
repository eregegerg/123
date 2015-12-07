/**
 * Created by Anton on 06.12.2015.
 */
var debug = require('debug')('youtube');
var base = require('../base');
var Promise = require('bluebird');
var request = require('request');
var requestPromise = Promise.promisify(request);

Youtube = function(options) {
    "use strict";
    var _this = this;
    this.gOptions = options;
    this.config = {};

    this.onReady = base.storage.get('userIdToChannelId').then(function(storage) {
        _this.config.token = options.config.ytToken;
        _this.config.userIdToChannelId = storage.userIdToChannelId || {};
    });
};

Youtube.prototype.apiNormalization = function(userId, data, viewers) {
    "use strict";
    var now = parseInt(Date.now() / 1000);
    var streams = [];
    data.items.forEach(function(origItem) {
        var snippet = origItem.snippet;

        if (snippet.liveBroadcastContent !== 'live') {
            return;
        }

        var videoId = origItem.id && origItem.id.videoId;
        if (!videoId) {
            throw new Error('Video id is not exists!');
        }

        var item = {
            _service: 'youtube',
            _addItemTime: now,
            _createTime: now,
            _id: videoId,
            _isOffline: false,
            _channelName: userId,

            viewers: viewers || 0,
            game: '',
            preview: 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault_live.jpg',
            created_at: snippet.snippet,
            channel: {
                display_name: snippet.channelTitle,
                name: snippet.channelId,
                status: snippet.title,
                url: 'https://gaming.youtube.com/watch?v=' + videoId
            }
        };

        if (typeof item.preview === 'string') {
            var sep = item.preview.indexOf('?') === -1 ? '?' : '&';
            item.preview += sep + '_=' + now;
        }

        streams.push(item);
    });
    return streams;
};

Youtube.prototype.getViewers = function(id) {
    "use strict";
    return requestPromise({
        url: 'https://gaming.youtube.com/live_stats',
        qs: {
            v: id,
            t: Date.now()
        }
    }).then(function(response) {
        response = response.body;
        if (/^\d+$/.test(response)) {
            return parseInt(response);
        }

        throw new Error('Value is not int');
    }).catch(function(err) {
        debug('Error request viewers!', err);

        return -1;
    });
};

Youtube.prototype.getChannelId = function(userId) {
    "use strict";
    var _this = this;
    return Promise.resolve().then(function() {
        if (_this.config.userIdToChannelId[userId]) {
            return _this.config.userIdToChannelId[userId];
        }

        if (/^UC/.test(userId)) {
            return userId;
        }

        return requestPromise({
            method: 'GET',
            url: 'https://www.googleapis.com/youtube/v3/channels',
            qs: {
                part: 'snippet',
                forUsername: userId,
                maxResults: 1,
                fields: 'items/id',
                key: _this.config.token
            },
            json: true
        }).then(function(response) {
            response = response.body;
            var id = response.items[0].id;

            _this.config.userIdToChannelId[userId] = id;
            base.storage.set({userIdToChannelId: _this.config.userIdToChannelId});

            return id;
        });
    });
};

Youtube.prototype.getStreamList = function(userList) {
    "use strict";
    var _this = this;
    return Promise.resolve().then(function() {
        if (!userList.length) {
            return [];
        }

        var streamList = [];

        var requestList = userList.map(function(userId) {
            return _this.getChannelId(userId).then(function(channelId) {
                return requestPromise({
                    method: 'GET',
                    url: 'https://www.googleapis.com/youtube/v3/search',
                    qs: {
                        part: 'snippet',
                        channelId: channelId,
                        eventType: 'live',
                        maxResults: 1,
                        order: 'date',
                        safeSearch: 'none',
                        type: 'video',
                        fields: 'items(id,snippet)',
                        key: _this.config.token
                    },
                    json: true
                }).then(function(response) {
                    response = response.body;
                    if (response.items.length === 0) {
                        return [];
                    }

                    var videoId = null;
                    response.items.some(function(item) {
                        if (item.id && (videoId = item.id.videoId)) {
                            return true;
                        }
                    });

                    if (!videoId) {
                        debug('VideoId is not found!');
                        return [];
                    }

                    return _this.getViewers(videoId).then(function(viewers) {
                        return _this.apiNormalization(userId, response, viewers);
                    });
                });
            }).then(function(stream) {
                streamList.push.apply(streamList, stream);
            }).catch(function(err) {
                debug('Stream list item response error!', err);
            });
        });

        return Promise.all(requestList).then(function() {
            return streamList;
        });
    });
};

Youtube.prototype.getChannelName = function(userId) {
    "use strict";
    var _this = this;

    return _this.getChannelId(userId).then(function(channelId) {
        return requestPromise({
            method: 'GET',
            url: 'https://www.googleapis.com/youtube/v3/search',
            qs: {
                part: 'snippet',
                id: channelId,
                maxResults: 1,
                fields: 'items(id,snippet)',
                key: _this.config.token
            },
            json: true
        }).then(function(response) {
            response = response.body;
            var id = response.items[0].id;

            return Promise.resolve(userId, id === userId ? undefined : id);
        });
    });
};

module.exports = Youtube;