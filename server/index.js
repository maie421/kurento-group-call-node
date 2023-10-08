
import path from 'path';
import url from 'url';
import http from 'http';
import https from 'https';
import fs from 'fs';

import express from 'express';
import kurento from 'kurento-client';
import socketIO from 'socket.io';
import minimst from 'minimist';
import cors from 'cors';

import { Session, Register } from './lib';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let userRegister = new Register();
let rooms = {};

const argv = minimst(process.argv.slice(2), {
    default: {
        //as_uri: 'http://localhost:3000',
        as_uri: 'https://localhost:3000',
        ws_uri: 'ws://13.124.5.88:8888/kurento',
        ice_servers: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
        ],
    }
});


/////////////////////////// https ///////////////////////////////
let app = express();
app.use(cors());

let asUrl = url.parse(argv.as_uri);
let port = asUrl.port;

const options = {
    key: fs.readFileSync('./server/keys/server.key'),
    cert: fs.readFileSync('./server/keys/server.crt')
};

let server = https.createServer(options, app).listen(port, () => {
    console.log('Kurento Group Call started');
    console.log('Open %s with a WebRTC capable brower.', url.format(asUrl));
});

// let server = http.createServer(app).listen(port, () => {
//      console.log('Kurento Group Call started');
// });

/////////////////////////// websocket ///////////////////////////////

let io = socketIO(server).path('/groupcall');
let wsUrl = url.parse(argv.ws_uri).href;

io.on('connection', socket => {
    socket.on('error', error => {
        console.error(`Connection %s error : %s`, socket.id, error);
    });

    socket.on('disconnect', data => {
        console.log(`Connection : %s disconnect`, data);
    });

    socket.on('message', message => {
        console.log(`Connection: %s receive message`, message.id);

        switch (message.id) {
            case 'joinRoom':
                joinRoom(socket, message, err => {
                    if (err) {
                        console.error(`join Room error ${err}`);
                    }
                });
                break;
            case 'receiveVideoFrom': //보낸 사람으로 부터 비디오 수신
                receiveVideoFrom(socket, message.sender, message.sdpOffer, (error) => {
                    if (error) {
                        console.error(error);
                    }
                });
                break;
            case 'leaveRoom': //방 나가기
                leaveRoom(socket, (error) => {
                    if (error) {
                        console.error(error);
                    }
                });
                break;
            case 'onIceCandidate':
                addIceCandidate(socket, message, (error) => {
                    if (error) {
                        console.error(error);
                    }
                });
                break;
            default:
                socket.emit({id: 'error', msg: `Invalid message ${message}`});
        }
    });

});


/**
 * 
 * @param {*} socket 
 * @param {*} message 
 * @param {*} callback 
 */
function joinRoom(socket, message, callback) {
    getRoom(message.roomName, (error, room) => {
        if (error) {
            callback(error);
            return;
        }
        join(socket, room, message.name, (err, user) => {
            console.log(`join success : ${user.name}`);
            if (err) {
                callback(err);
                return;
            }
            callback();
        });
    });
}

/**
 * 방 없으면 생성하고 방있으면 해당 방 정보 가져 오도록
 * 
 * @param {string} roomName 
 * @param {function} callback 
 */
function getRoom(roomName, callback) {
    let room = rooms[roomName];

    if (room == null) {
        console.log(`create new room : ${roomName}`);
        getKurentoClient((error, kurentoClient) => {
            if (error) {
                return callback(error);
            }

            kurentoClient.create('MediaPipeline', (error, pipeline) => {
                if (error) {
                    return callback(error);
                }
                room = {
                    name: roomName,
                    pipeline: pipeline,
                    participants: {}, //참가자들
                    kurentoClient: kurentoClient
                };

                rooms[roomName] = room;
                callback(null, room);
            });
        });
    } else {
        console.log(`get existing room : ${roomName}`);
        callback(null, room);
    }
}


/**
 * join call room
 * 
 * @param {*} socket 
 * @param {*} room 
 * @param {*} userName 
 * @param {*} callback 
 */
function join(socket, room, userName, callback) {
    let userSession = new Session(socket, userName, room.name);
    userRegister.register(userSession);

    room.pipeline.create('WebRtcEndpoint', (error, outgoingMedia) => {
        if (error) {
            console.error('no participant in room');
            if (Object.keys(room.participants).length === 0) {
                room.pipeline.release();
            }
            return callback(error);
        }

        //미디어 정보 사이즈 수정
        outgoingMedia.setMaxVideoRecvBandwidth(300);
        outgoingMedia.setMinVideoRecvBandwidth(100);
        //미디어 정보 사이즈 저장
        userSession.setOutgoingMedia(outgoingMedia);

        // add ice candidate the get sent before endpoint is established
        // socket.id : room iceCandidate Queue
        let iceCandidateQueue = userSession.iceCandidateQueue[userSession.name];
        if (iceCandidateQueue) {
            while (iceCandidateQueue.length) {
                let message = iceCandidateQueue.shift(); //첫 번째 요소를 제거하고, 제거된 요소를 반환
                console.error(`user: ${userSession.id} collect candidate for outgoing media`);
                userSession.outgoingMedia.addIceCandidate(message.candidate);
            }
        }

        //ICE
        userSession.outgoingMedia.on('OnIceCandidate', event => {
            let candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            // 현재 접속해있는 모든 클라이언트에게 이벤트 전달
            userSession.sendMessage({
                id: 'iceCandidate',
                name: userSession.name,
                candidate: candidate
            });
        });

         let usersInRoom = room.participants;

         //다른 참가자로 부터 비디오를 수신하고 회의실에 추가
        for (let i in usersInRoom) {
            if (usersInRoom[i].name != userSession.name) {
                usersInRoom[i].sendMessage({
                    id: 'newParticipantArrived',
                    name: userSession.name
                });
            }
        }

        let existingUsers = [];
        for (let i in usersInRoom) {
            if (usersInRoom[i].name != userSession.name) {
                existingUsers.push(usersInRoom[i].name);
            }
        }

        //기존 화상 회의실에 새 참가자를 추가
        userSession.sendMessage({
            id: 'existingParticipants',
            data: existingUsers,
            roomName: room.name
        });

        //방에 참가자 추가
        room.participants[userSession.name] = userSession;

        callback(null, userSession);
    });
}

/**
 * 보낸 사람으로 부터 비디오 수신
 * 
 * @param {*} socket 
 * @param {*} senderName 
 * @param {*} sdpOffer 
 * @param {*} callback 
 */
function receiveVideoFrom(socket, senderName, sdpOffer, callback) {
    let userSession = userRegister.getById(socket.id);
    let sender = userRegister.getByName(senderName);

    getEndpointForUser(userSession, sender, (error, endpoint) => {
        if (error) {
            console.error(error);
            callback(error);
        }

        //원격 피어의 SDP 제안을 처리하고 엔드포인트의 기능을 기반으로 SDP 응답을 생성
        endpoint.processOffer(sdpOffer, (error, sdpAnswer) => {
            console.log(`process offer from ${sender.name} to ${userSession.name}`);
            if (error) {
                return callback(error);
            }
            let data = {
                id: 'receiveVideoAnswer',
                name: sender.name,
                sdpAnswer: sdpAnswer
            };
            userSession.sendMessage(data);

            //후보자 모으기
            endpoint.gatherCandidates(error => {
                if (error) {
                    return callback(error);
                }
            });

            return callback(null, sdpAnswer);
        });
    });
}


/**
 * 
 */
function leaveRoom(socket, callback) {
    var userSession = userRegister.getById(socket.id);

    if (!userSession) {
        return;
    }

    var room = rooms[userSession.roomName];

    if(!room){
        return;
    }

    console.log('notify all user that ' + userSession.name + ' is leaving the room ' + room.name);
    var usersInRoom = room.participants;
    delete usersInRoom[userSession.name]; //방안에 있는 본인 꺼 제거
    userSession.outgoingMedia.release(); // 본인꺼 미디어 해제

    for (var i in userSession.incomingMedia) {
        userSession.incomingMedia[i].release(); //본인 기준 본인제외 나머지 해제
        delete userSession.incomingMedia[i]; //본인 기준 본인제외 나머지 삭제
    }

    var data = {
        id: 'participantLeft',
        name: userSession.name
    };

    //상대방 기준
    for (var i in usersInRoom) {
        var user = usersInRoom[i];

        user.incomingMedia[userSession.name].release();
        delete user.incomingMedia[userSession.name];
        //참여자가 회의 또는 채팅에서 나간 경우 그 참여자의 데이터를 정리하고 삭제
        user.sendMessage(data);
    }

    //참여자가 없다면 방 없애기
    if (Object.keys(room.participants).length == 0) {
        room.pipeline.release();
        delete rooms[userSession.roomName];
    }
    delete userSession.roomName;
}


/**
 * getKurento Client
 * 
 * @param {function} callback 
 */
function getKurentoClient(callback) {
    kurento(wsUrl, (error, kurentoClient) => {
        if (error) {
            let message = `Could not find media server at address ${wsUrl}`;
            return callback(`${message} . Exiting with error ${error}`);
        }
        callback(null, kurentoClient);
    });
}

/**
 *  Add ICE candidate, required for WebRTC calls
 * 
 * @param {*} socket 
 * @param {*} message 
 * @param {*} callback 
 */
function addIceCandidate(socket, message, callback) {
    let user = userRegister.getById(socket.id);
    if (user != null) {
        // assign type to IceCandidate
        let candidate = kurento.register.complexTypes.IceCandidate(message.candidate);
        user.addIceCandidate(message, candidate);
        callback();
    } else {
        console.error(`ice candidate with no user receive : ${message.sender}`);
        callback(new Error("addIceCandidate failed"));
    }
}


/**
 * 
 * @param {*} userSession 
 * @param {*} sender 
 * @param {*} callback 
 */
function getEndpointForUser(userSession, sender, callback) {
    //본인
    if (userSession.name === sender.name) {
        return callback(null, userSession.outgoingMedia);
    }

    let incoming = userSession.incomingMedia[sender.name];
    
    if (incoming == null) {
        console.log(`user : ${userSession.id} create endpoint to receive video from : ${sender.id}`);
        getRoom(userSession.roomName, (error, room) => {
            if (error) {
                console.error(error);
                callback(error);
                return;
            }
            room.pipeline.create('WebRtcEndpoint', (error, incoming) => {
                if (error) {
                    if (Object.keys(room.participants).length === 0) {
                        room.pipeline.release();
                    }
                    console.error('error: ' + error);
                    callback(error);
                    return;
                }

                console.log(`user: ${userSession.name} successfully create pipeline`);
                incoming.setMaxVideoRecvBandwidth(300);
                incoming.setMinVideoRecvBandwidth(100);
                userSession.incomingMedia[sender.name] = incoming;
                

                // add ice candidate the get sent before endpoints is establlished
                let iceCandidateQueue = userSession.iceCandidateQueue[sender.name];
                if (iceCandidateQueue) {
                    while (iceCandidateQueue.length) {
                        let message = iceCandidateQueue.shift();
                        console.log(`user: ${userSession.name} collect candidate for ${message.data.sender}`);
                        incoming.addIceCandidate(message.candidate);
                    }
                }

                incoming.on('OnIceCandidate', event => {
                    // ka ka ka ka ka
                    // console.log(`generate incoming media candidate: ${userSession.id} from ${sender.id}`);
                    let candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    userSession.sendMessage({
                        id: 'iceCandidate',
                        name: sender.name,
                        candidate: candidate
                    });
                });

                sender.outgoingMedia.connect(incoming, error => {
                    if (error) {
                        console.log(error);
                        callback(error);
                        return;
                    }
                    callback(null, incoming);
                });
            });
        })
    } else {
        console.log(`user: ${userSession.name} get existing endpoint to receive video from: ${sender.name}`);
        sender.outgoingMedia.connect(incoming, error => {
            if (error) {
                callback(error);
            }
            callback(null, incoming);
        });
    }
}


app.use(express.static(path.join(__dirname, 'static')));