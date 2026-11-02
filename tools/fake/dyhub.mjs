import { WebSocketServer } from "ws";
const wss = new WebSocketServer({ port: 8757, path: "/ws" });
console.log("fake dyhub on 8757");
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "__hello", roomId: "test" }));
  ws.send(JSON.stringify({ type: "__connecting", roomId: "test" }));
  setTimeout(() => ws.send(JSON.stringify({ type: "__connected", roomId: "test" })), 200);
  setTimeout(() => ws.send(JSON.stringify({ type: "roomStatus", id: "s1", data: { status: "live" } })), 300);
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    if (n === 3) {
      ws.send(JSON.stringify({ type: "roomStatus", id: "closed-1", data: { status: "closed" } }));
      return;
    }
    ws.send(JSON.stringify({
      id: `evt-${n}`, roomId: "test", type: "chat", ts: Date.now(),
      user: { id: `u${n}`, nickname: `观众${n}` },
      data: { content: n === 1 ? "去挖点铁矿" : n === 2 ? "跳岩浆" : "666" },
    }));
  }, 700);
  ws.on("close", () => clearInterval(timer));
});
