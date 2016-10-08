/**
 * Created by Anton on 02.10.2016.
 */
var base = require('./base');
var debug = require('debug')('MsgSender');
var Promise = require('bluebird');
var request = require('request');
var requestPromise = Promise.promisify(request);

var MsgSender = function (options) {
    "use strict";
    var _this = this;
    _this.gOptions = options;

    _this.requestPromiseMap = {};
};

MsgSender.prototype.onSendMsgError = function(err, chatId) {
    err = err && err.message || err;
    var needKick = /^403\s+/.test(err);

    if (!needKick) {
        needKick = /group chat is deactivated/.test(err);
    }

    if (!needKick) {
        needKick = /chat not found"/.test(err);
    }

    if (!needKick) {
        needKick = /channel not found"/.test(err);
    }

    if (!needKick) {
        needKick = /USER_DEACTIVATED/.test(err);
    }

    var jsonRe = /^\d+\s+(\{.+})$/;
    if (jsonRe.test(err)) {
        var msg = null;
        try {
            msg = err.match(jsonRe);
            msg = msg && msg[1];
            msg = JSON.parse(msg);
        } catch (e) {
            msg = null;
        }

        if (msg && msg.parameters) {
            var parameters = msg.parameters;
            if (parameters.migrate_to_chat_id) {
                this.gOptions.chat.chatMigrate(chatId, parameters.migrate_to_chat_id);
            }
        }
    }

    if (!needKick) {
        return;
    }

    if (/^@\w+$/.test(chatId)) {
        this.gOptions.chat.removeChannel(chatId);
    } else {
        this.gOptions.chat.removeChat(chatId);
    }
    return true;
};

MsgSender.prototype.downloadImg = function (stream) {
    "use strict";
    var _this = this;
    var requestLimit = 0;
    var requestTimeoutSec = 30;

    var refreshRequestLimit = function () {
        var _requestLimit = _this.gOptions.config.sendPhotoRequestLimit;
        if (_requestLimit) {
            requestLimit = _requestLimit;
        }

        var _requestTimeoutSec = _this.gOptions.config.sendPhotoRequestTimeoutSec;
        if (_requestTimeoutSec) {
            requestTimeoutSec = _requestTimeoutSec;
        }

        requestTimeoutSec *= 1000;
    };
    refreshRequestLimit();

    var previewList = stream.preview;

    var requestPic = function (index) {
        var previewUrl = previewList[index];
        return requestPromise({
            url: previewUrl,
            encoding: null,
            gzip: true,
            forever: true
        }).then(function (response) {
            if (response.statusCode === 404) {
                throw new Error('404');
            }

            return response;
        }).catch(function(err) {
            // debug('Request photo error! %s %s %s %s', index, stream._channelId, previewUrl, err);

            index++;
            if (index < previewList.length) {
                return requestPic(index);
            }

            if (requestLimit > 0) {
                requestLimit--;
                return new Promise(function(resolve) {
                    setTimeout(resolve, requestTimeoutSec);
                }).then(function() {
                    // debug("Retry %s request photo %s %s! %s", requestLimit, chatId, stream._channelId, err);
                    return requestPic(0);
                });
            }

            throw 'Request photo error!';
        });
    };

    return requestPic(0).then(function (response) {
        var image = new Buffer(response.body, 'binary');
        return image;
    });
};

MsgSender.prototype.getPicId = function(chatId, text, stream) {
    "use strict";
    var _this = this;
    var sendPicLimit = 0;
    var sendPicTimeoutSec = 5;

    var refreshRetryLimit = function () {
        var _retryLimit = _this.gOptions.config.sendPhotoMaxRetry;
        if (_retryLimit) {
            sendPicLimit = _retryLimit;
        }

        var _retryTimeoutSec = _this.gOptions.config.sendPhotoRetryTimeoutSec;
        if (_retryTimeoutSec) {
            sendPicTimeoutSec = _retryTimeoutSec;
        }

        sendPicTimeoutSec *= 1000;
    };
    refreshRetryLimit();

    var sendingPic = function() {
        var sendPic = function(photo) {
            return Promise.try(function() {
                return _this.gOptions.bot.sendPhoto(chatId, photo, {
                    caption: text
                });
            }).catch(function(err) {
                var imgProcessError = [
                    /IMAGE_PROCESS_FAILED/,
                    /FILE_PART_0_MISSING/
                ].some(function(re) {
                    return re.test(err);
                });

                if (imgProcessError && sendPicLimit > 0) {
                    sendPicLimit--;
                    return new Promise(function(resolve) {
                        setTimeout(resolve, sendPicTimeoutSec);
                    }).then(function() {
                        debug("Retry %s send photo file %s %s! %s", sendPicLimit, chatId, stream._channelId, err);
                        return sendingPic();
                    });
                }

                throw err;
            });
        };

        return _this.downloadImg(stream).then(function (buffer) {
            return sendPic(buffer);
        });
    };

    return sendingPic().catch(function(err) {
        debug('Send photo file error! %s %s %s', chatId, stream._channelId, err);

        var isKicked = _this.onSendMsgError(err, chatId);

        if (isKicked) {
            throw 'Send photo file error! Bot was kicked!';
        }

        throw 'Send photo file error!';
    });
};

/**
 * @param {Object} stream
 * @param {Object} msg
 * @param {number} msg.chatId
 * @param {number} msg.id
 */
MsgSender.prototype.addMsgInStream = function (stream, msg) {
    "use strict";
    var msgArray = stream.msgArray;
    if (!msgArray) {
        msgArray = stream.msgArray = [];
    }
    msgArray.push(msg);

    var chatMsgList = msgArray.filter(function (item) {
        return item.chatId === msg.chatId;
    }).reverse();

    var limit = 20;
    if (chatMsgList.length > limit) {
        chatMsgList.slice(limit).forEach(function (item) {
            base.removeItemFromArray(msgArray, item);
        });
    }

    this.gOptions.events.emit('saveStreamList');
};

MsgSender.prototype.getMsgFromStream = function (stream) {
    "use strict";
    return stream.msgArray || [];
};

MsgSender.prototype.removeMsgFromStream = function (stream, msg) {
    "use strict";
    var msgArray = this.getMsgFromStream(stream);
    var pos = msgArray.indexOf(msg);
    if (pos !== -1) {
        msgArray.splice(pos, 1);
    }

    this.gOptions.events.emit('saveStreamList');
};

MsgSender.prototype.getPicIdCache = function (chatId, text, stream) {
    var cache = this.requestPromiseMap;
    var id = stream._id;

    return cache[id] = this.getPicId(chatId, text, stream).finally(function () {
        delete cache[id];
    });
};

MsgSender.prototype.getStreamChatIdList = function (stream) {
    "use strict";
    var chatList = this.gOptions.storage.chatList;

    var chatIdList = [];

    Object.keys(chatList).forEach(function (chatId) {
        var chatItem = chatList[chatId];

        var userChannelList = chatItem.serviceList && chatItem.serviceList[stream._service];
        if (!userChannelList) {
            return;
        }

        if (userChannelList.indexOf(stream._channelId) === -1) {
            return;
        }

        chatIdList.push(chatItem.chatId);
    });

    return chatIdList;
};

MsgSender.prototype.updateMsg = function (msg, text, noPhotoText) {
    "use strict";
    var _this = this;
    var sendPromise = null;
    if (msg.type === 'streamPhoto') {
        sendPromise = _this.gOptions.bot.editMessageCaption(
            msg.chatId,
            text,
            {
                message_id: msg.id
            }
        );
    } else
    if (msg.type === 'streamText') {
        sendPromise = _this.gOptions.bot.editMessageText(
            msg.chatId,
            noPhotoText,
            {
                message_id: msg.id
            }
        );
    }
    return sendPromise;
};

MsgSender.prototype.updateNotify = function (stream) {
    "use strict";
    var _this = this;
    var text = base.getNowStreamPhotoText(this.gOptions, stream);
    var noPhotoText = base.getNowStreamText(this.gOptions, stream);

    var chatIdList = this.getStreamChatIdList(stream);

    if (!chatIdList.length) {
        return Promise.resolve();
    }

    var msgArray = this.getMsgFromStream(stream).slice(0);

    var promiseArr = msgArray.map(function (msg) {
        return _this.updateMsg(msg, text, noPhotoText).then(function () {
            if (msg.type === 'streamPhoto') {
                _this.track(msg.chatId, stream, 'updatePhoto');
            } else
            if (msg.type === 'streamText') {
                _this.track(msg.chatId, stream, 'updateText');
            }
        }).catch(function (e) {
            var err = e && e.message || e;
            if (!/message is not modified/.test(err)) {
                debug('Edit msg error %s', e);
            }
        });
    });

    return Promise.all(promiseArr);
};

MsgSender.prototype.sendNotify = function(chatIdList, text, noPhotoText, stream, useCache) {
    "use strict";
    var _this = this;

    var bot = _this.gOptions.bot;
    var sendMsg = function(chatId) {
        return bot.sendMessage(chatId, noPhotoText, {
            disable_web_page_preview: true,
            parse_mode: 'HTML'
        }).then(function(msg) {
            _this.addMsgInStream(stream, {
                type: 'streamText',
                chatId: chatId,
                id: msg.message_id
            });

            _this.track(chatId, stream, 'sendMsg');
        }).catch(function(err) {
            debug('Send text msg error! %s %s %s', chatId, stream._channelId, err);

            var isKicked = _this.onSendMsgError(err, chatId);
            if (!isKicked) {
                throw err;
            }
        });
    };

    var sendPhoto = function(chatId, fileId) {
        return bot.sendPhoto(chatId, fileId, {
            caption: text
        }).then(function(msg) {
            _this.addMsgInStream(stream, {
                type: 'streamPhoto',
                chatId: chatId,
                id: msg.message_id
            });

            _this.track(chatId, stream, 'sendPhoto');
        }).catch(function(err) {
            debug('Send photo msg error! %s %s %s', chatId, stream._channelId, err);

            var isKicked = _this.onSendMsgError(err, chatId);
            if (!isKicked) {
                throw err;
            }
        });
    };

    var send = function() {
        var chatId = null;
        var photoId = stream._photoId;
        var promiseList = [];

        while (chatId = chatIdList.shift()) {
            if (!photoId || !text) {
                promiseList.push(sendMsg(chatId));
            } else {
                promiseList.push(sendPhoto(chatId, photoId));
            }
        }

        return Promise.all(promiseList);
    };

    if (!stream.preview.length) {
        return send();
    }

    if (!text) {
        return send();
    }

    if (useCache && stream._photoId) {
        return send();
    }

    var requestPicId = function() {
        if (!chatIdList.length) {
            // debug('chatList is empty! %j', stream);
            return Promise.resolve();
        }

        var promise = _this.requestPromiseMap[stream._id];
        if (promise) {
            return promise.then(function(msg) {
                stream._photoId = msg.photo[0].file_id;
            }, function(err) {
                if (err === 'Send photo file error! Bot was kicked!') {
                    return requestPicId();
                }
            });
        }

        var chatId = chatIdList.shift();

        return _this.getPicIdCache(chatId, text, stream).then(function(msg) {
            _this.addMsgInStream(stream, {
                type: 'streamPhoto',
                chatId: chatId,
                id: msg.message_id
            });

            stream._photoId = msg.photo[0].file_id;

            _this.track(chatId, stream, 'sendPhoto');
        }, function(err) {
            if (err === 'Send photo file error! Bot was kicked!') {
                return requestPicId();
            }

            chatIdList.unshift(chatId);
            debug('Function getPicId throw error!', err);
        });
    };

    return requestPicId().then(function() {
        return send();
    });
};

MsgSender.prototype.track = function(chatId, stream, title) {
    "use strict";
    return this.gOptions.tracker.track({
        text: stream._channelId,
        from: {
            id: 1
        },
        chat: {
            id: chatId
        },
        date: base.getNow()
    }, title);
};

module.exports = MsgSender;