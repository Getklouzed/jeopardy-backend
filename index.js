// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://jeopardy-sami.vercel.app",
    methods: ["GET", "POST"],
  },
});



// In-memory room storage
const rooms = {}; // rooms[code] = { players: [], chat: [], board: [], scores: [], numPlayers, currentQuestion, finalQuestion }

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}


// Per-room Final Jeopardy storage
const finalWagersByRoom = {}; // { roomCode: { playerId: wager } }
const finalAnswersByRoom = {}; // { roomCode: { playerId: answer } }

io.on("connection", (socket) => {
  console.log("New client connected", socket.id);

  // ---------- ROOM CREATION ----------
  socket.on("createRoom", ({ numPlayers }, callback) => {
    const code = generateRoomCode();
    rooms[code] = {
      players: [],
      chat: [],
      board: [],
      scores: [],
      numPlayers: Number(numPlayers) || 2,
      currentQuestion: null,
      finalQuestion: null,
    };

    socket.join(code);
    callback({ code });
    console.log("Room created:", code, "Limit:", rooms[code].numPlayers);
  });

  socket.on("updateRoomLimit", ({ code, numPlayers }) => {
    const room = rooms[code];
    if (!room) return;
    room.numPlayers = numPlayers;
    io.to(code).emit("roomUpdated", room);
  });

  // ---------- JOIN ROOM ----------
  socket.on("joinRoom", ({ code, name }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ error: "Room not found" });
    if (room.players.length >= room.numPlayers)
      return callback({ error: "Room is full" });

    const player = { id: socket.id, name, score: 0 };
    room.players.push(player);
    socket.join(code);

    io.to(code).emit("updatePlayers", room.players);
    callback({ code, player, roomPlayers: room.players });
    console.log(`${name} joined room ${code}`);
  });

  // ---------- CHAT ----------
  socket.on("chatMessage", ({ code, sender, message }) => {
    const room = rooms[code];
    if (!room) return;
    room.chat.push({ sender, message });
    io.to(code).emit("chatUpdate", room.chat);
  });

  // ---------- GAME ----------
  socket.on("startGame", ({ roomCode, scores, boardPlayable }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.board = boardPlayable || [];
    room.scores = scores || [];
    io.to(roomCode).emit("gameStarted", {
      boardPlayable: room.board,
      scores: room.scores,
    });
  });

  socket.on("selectQuestion", ({ roomCode, question }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit("questionSelected", question);
  });

  socket.on("cellClicked", ({ roomCode, colIndex, rowIndex }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const question = room.board?.[colIndex]?.questions?.[rowIndex];
    if (question) {
      question.asked = true;
      io.to(roomCode).emit("cellClicked", { colIndex, rowIndex, question });
    }
  });

  socket.on("updateScores", ({ roomCode, scores }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.scores = scores;
    io.to(roomCode).emit("updateScores", room.scores);
  });

  socket.on("openQuestionModal", ({ roomCode, question }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentQuestion = { ...question, showAnswer: false };
    io.to(roomCode).emit("updateQuestionModal", room.currentQuestion);
  });

  socket.on("revealAnswer", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room?.currentQuestion) return;

    room.currentQuestion.showAnswer = true;
    io.to(roomCode).emit("updateQuestionModal", room.currentQuestion);
  });

  socket.on("allocatePoints", ({ roomCode, playerId, points }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) player.score = (player.score || 0) + (Number(points) || 0);
    io.to(roomCode).emit("updatePlayers", room.players);
  });

  socket.on("dailyDouble", ({ roomCode, playerId, wager }) => {
    io.to(roomCode).emit("dailyDoubleActivated", { playerId, wager });
  });

  socket.on("closeQuestionModal", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentQuestion = null;
    io.to(roomCode).emit("updateQuestionModal", null);
  });

  socket.on("advanceStage", ({ roomCode, currentStage, boardPlayable }) => {
    if (!roomCode) return;
    io.to(roomCode).emit("stageAdvanced", { currentStage, boardPlayable });
  });

  // ---------- FINAL JEOPARDY ----------

socket.on("revealFinalCategory", ({ roomCode, category }) => {
  const room = rooms[roomCode];
  if (!room) {
    console.log(`[DEBUG] Room ${roomCode} does not exist`);
    return;
  }

  // Optionally store it in room.finalQuestion
  if (!room.finalQuestion) room.finalQuestion = {};
  room.finalQuestion.category = category;

  console.log(`[DEBUG] Emitting category for room ${roomCode}:`, category);

  // Emit to all clients in the room
  io.to(roomCode).emit("finalJeopardyCategory", { category });
});



socket.on("submitFinalWager", ({ roomCode, playerId, wager }) => {
    if (!finalWagersByRoom[roomCode]) finalWagersByRoom[roomCode] = {};
    finalWagersByRoom[roomCode][playerId] = wager;

    const roomPlayers = rooms[roomCode]?.players || [];
    const allSubmitted = roomPlayers.every(p => finalWagersByRoom[roomCode][p.id] !== undefined);

    console.log("Room players:", roomPlayers.map(p => p.id));
    console.log("Current wagers:", finalWagersByRoom[roomCode]);
    console.log("All submitted?", allSubmitted);

    io.to(roomCode).emit("updateFinalWagers", {
        finalWagers: finalWagersByRoom[roomCode],
        allSubmitted,
    });
});

socket.on("startFinalJeopardy", ({ roomCode, question }) => {
  const room = rooms[roomCode];
  if (!room) return;

  // Store the full question object for this room
  room.finalQuestion = { ...question, showAnswer: false };
  finalAnswersByRoom[roomCode] = {}; // reset answers

  // Save original scores for each player
  room.players.forEach(p => {
    const savedScore = room.scores.find(s => s.id === p.id)?.score || 0;
    p.originalScore = savedScore;
  });

  // Emit to all clients
  io.to(roomCode).emit("finalJeopardyStarted", {
    category: question.category,
    question: question.question,
    answer: question.answer,  // included on server side
    media: question.media || null,
    showAnswer: false
  });
});


socket.on("submitFinalAnswer", ({ roomCode, playerId, answer }) => {
    if (!finalAnswersByRoom[roomCode]) finalAnswersByRoom[roomCode] = {};

    finalAnswersByRoom[roomCode][playerId] = answer;

    // Compute room players and check if all submitted
    const roomPlayers = rooms[roomCode]?.players || [];
    const allAnswered = roomPlayers.every(p => finalAnswersByRoom[roomCode][p.id] !== undefined);

    console.log("Room players:", roomPlayers.map(p => p.id));
    console.log("Current answers:", finalAnswersByRoom[roomCode]);
    console.log("All submitted?", allAnswered);

    // Notify everyone that this player submitted
    io.to(roomCode).emit("finalAnswerUpdate", {
        playerId,
        status: "submitted",
        allAnswered,
    });

    // If all players submitted, enable host's Reveal Answer button
    if (allAnswered) {
        io.to(roomCode).emit("enableRevealAnswer");
    }
});

socket.on("revealFinalResults", ({ roomCode }) => {
  const room = rooms[roomCode];
  if (!room) {
    console.log(`[DEBUG] Room ${roomCode} not found`);
    return;
  }

  if (!room.finalQuestion) {
    console.log(`[DEBUG] Room ${roomCode} has no finalQuestion!`);
    return;
  }

  console.log(`[DEBUG] Revealing final results for room ${roomCode}`, room.finalQuestion);

  // Ensure we have original scores for all players
  room.players.forEach(p => {
    if (p.originalScore === undefined) p.originalScore = p.score || 0;
  });

  console.log(`[DEBUG] Original scores snapshot:`, room.players.map(p => ({ id: p.id, name: p.name, originalScore: p.originalScore })));
  console.log(`[DEBUG] Final wagers:`, finalWagersByRoom[roomCode]);
  console.log(`[DEBUG] Final answers:`, finalAnswersByRoom[roomCode]);

  // Compute each player's result using snapshot
  const results = room.players.map((p) => {
    const baseScore = p.originalScore; // snapshot before Final Jeopardy
    const wager = finalWagersByRoom[roomCode]?.[p.id] || 0;
    const answer = finalAnswersByRoom[roomCode]?.[p.id] || "";
    const correct = answer.trim().toLowerCase() === room.finalQuestion.answer.trim().toLowerCase();

    const newScore = correct ? baseScore + wager : baseScore - wager;
    p.score = newScore;

    console.log(`[DEBUG] ${p.name}: baseScore=${baseScore}, wager=${wager}, correct=${correct}, newScore=${newScore}`);

    return {
      id: p.id,
      name: p.name,
      wager,
      answer,
      correct,
      score: newScore,
    };
  });

  // Emit structured results to all clients
  io.to(roomCode).emit("finalResults", {
    results, // array of player results
    correctAnswer: room.finalQuestion.answer, // the correct answer
  });

  // Clean up Final Jeopardy data
  finalWagersByRoom[roomCode] = {};
  finalAnswersByRoom[roomCode] = {};
  room.finalQuestion = null;
});


  // ---------- DISCONNECT ----------
  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
    for (const code in rooms) {
      const room = rooms[code];
      const before = room.players.length;
      room.players = room.players.filter((p) => p.id !== socket.id);
      if (room.players.length !== before) io.to(code).emit("updatePlayers", room.players);
    }
  });
});

const PORT = process.env.PORT || 4000; // fallback for local dev
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
