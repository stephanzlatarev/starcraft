import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "node:child_process";

const PORT_API = Number(process.env.PORT_API) || 5000;
const PORT_LOG = Number(process.env.PORT_LOG) || 5001;

const CODE_PAUSE = 1;
const CODE_RESUME = 2;
const CODE_START_SYNC = 3;
const CODE_STOP_SYNC = 4;

const REQUEST_LEAVE_GAME = Buffer.from([42,0]);
const RESPONSE_LEAVE_GAME = Buffer.from([42,0,136,6,0,152,6,1]);

const REQUEST_QUIT = Buffer.from([66,0]);
const RESPONSE_QUIT = Buffer.from([66,0,136,6,0,152,6,6]);

const RESPONSE_ALREADY_JOINED = Buffer.from([18,6,8,3,26,2,8,1]);
const RESPONSE_ALREADY_INGAME = Buffer.from([136,6,0,146,6,17,65,108,114,101,97,100,121,32,105,110,32,97,32,103,97,109,101,152,6,3]);
const RESPONSE_ALREADY_REPLAY = Buffer.from([136,6,0,146,6,46,77,117,115,116,32,101,110,100,32,99,117,114,114,101,110,116,32,114,101,112,108,97,121,32,98,101,102,111,114,101,32,121,111,117,32,106,111,105,110,32,97,32,103,97,109,101,152,6,4]);
const RESPONSE_SUCCESS_JOINED = Buffer.from([18,2,8,1,136,6,0,152,6,3]);

const RESPONSE_ACTION_SUCCESS = Buffer.from([90,4,8,1,136,6,0,152,6,3]);
const RESPONSE_DEBUG_SUCCESS = Buffer.from([162,1,0,136,6,0,152,6,3]);

let socketToGame;
let socketToBot;
let socketToObserver;

let request = null;
let isPaused = false;
let isSynced = false;

function setPaused(flag) {
  console.log(flag ? "Game is paused" : "Game is resumed");

  isPaused = flag;
}

// When the bot is play syncing along a replay, it steps and receives game info and observations but its other commands are ignored
function setSynced(flag) {
  console.log(flag ? "Bot is play syncing" : "Bot is not play syncing");

  isSynced = flag;
}

function listenForObservers() {
  console.error("Listening for observer...");

  new WebSocketServer({ port: PORT_LOG }).on("connection", function(socket) {
    console.error("Observer connected");

    socketToObserver = socket;

    socket.on("error", console.error);

    socket.on("message", function(data) {
      switch (data[0]) {
        case CODE_PAUSE: return setPaused(true);
        case CODE_RESUME: return setPaused(false);
        case CODE_START_SYNC: return setSynced(true);
        case CODE_STOP_SYNC: return setSynced(false);
      }

      if (socket) sendToGame(socket, data);
    });

    socket.on("close", function() {
      if (socket === socketToObserver) {
        console.error("Observer disconnected");

        socketToObserver = null;
      }
    });
  });
}

function listenForBots() {
  console.error("Listening for bots...");

  new WebSocketServer({ port: PORT_API }).on("connection", function(socket) {
    console.error("Bot connected");

    socketToBot = socket;

    socket.on("error", console.error);

    socket.on("message", function(data) {
      if (is(data, REQUEST_LEAVE_GAME)) return socket.send(RESPONSE_LEAVE_GAME);
      if (is(data, REQUEST_QUIT)) return socket.send(RESPONSE_QUIT);

      if (socketToObserver) socketToObserver.send(data);

      if (isSynced) {
        switch (data[0]) {
          case 90: return socket.send(RESPONSE_ACTION_SUCCESS);
          case 162: return socket.send(RESPONSE_DEBUG_SUCCESS);
        }
      }

      if (socket) {
        if (data[0] === 18) {
          // Replace request to join a multiplayer game with request to join a single game
          sendToGame(socket, Buffer.from(replaceJoinRequest([...data])));
        } else {
          sendToGame(socket, data);
        }
      }
    });

    socket.on("close", function() {
      if (socket === socketToBot) {
        console.error("Bot disconnected");

        socketToBot = null;
      }
    });
  });
}

function connectToGame() {
  console.error("Starting StarCraft II...");

  const game = spawn("/StarCraftII/Versions/Base75689/SC2_x64", ["-listen", "127.0.0.1", "-port", "5555"]);

  game.stdout.on("data", function(data) {
    console.error(data.toString().trim());
  });

  game.stderr.on("data", function(data) {
    const text = data.toString().trim();

    console.error(text);

    if (text === "Startup Phase 3 complete. Ready for commands.") {
      const socket = new WebSocket("ws://127.0.0.1:5555/sc2api");

      socket.on("open", function open() {
        console.error("StarCraft II connected");

        socketToGame = socket;
      });

      socket.on("error", console.error);
    
      socket.on("message", function(data) {
        if (request && request.caller && (is(data, RESPONSE_ALREADY_JOINED) || is(data, RESPONSE_ALREADY_INGAME) || is(data, RESPONSE_ALREADY_REPLAY))) {
          console.log("Sending success response for join game request by bot");
          request.caller.send(RESPONSE_SUCCESS_JOINED);
          if (socketToObserver) socketToObserver.send(RESPONSE_SUCCESS_JOINED);
        } else {
          if (socketToObserver) socketToObserver.send(data);
          if (request && socketToBot && (request.caller === socketToBot)) socketToBot.send(data);
        }

        request = null;
      });
    }
  });

  game.on("close", function(details) {
    console.error("StarCraft II exited");

    if (details) console.error(details);

    connectToGame();
  });
}

// Copies race and options but only if they are at the start of the request
function replaceJoinRequest(data) {
  let race = [8,4];         // Random race
  let options = [26,2,8,1]; // raw=true
  let index = 2;
  let more = true;

  while (more) {
    switch (data[index]) {
      case 8: {
        // Read race
        race = data.slice(index, index + 2);
        index += race.length;
        break;
      }
      case 26: {
        // Read options
        options = data.slice(index, index + 2 + data[index + 1]);
        index += options.length;
        break;
      }
      default: {
        more = false;
      }
    }
  }

  const size = race.length + options.length;

  return [18, size, ...race, ...options];
}

async function sendToGame(caller, data) {
  while (!socketToGame) await sleep(10);
  while (request) await sleep(10);
  while (isPaused && (caller === socketToBot)) await sleep(10);

  request = { caller, data };

  socketToGame.send(data);
}

function is(a, b) {
  if (!a || !b || (a.length !== b.length)) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

listenForObservers();
listenForBots();
connectToGame();
