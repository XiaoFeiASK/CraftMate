import { WebSocketServer } from "ws";
const wss = new WebSocketServer({ port: 8757, path: "/ws" });
console.log("fake dyhub on 8757");
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "__hello", roomId: "test" }));
  ws.send(JSON.stringify({ type: "__connecting", roomId: "test" }));
  setTimeout(() => ws.send(JSON.stringify({ type: "__connected", roomId: "test" })), 200);
  setTimeout(() => ws.send(JSON.stringify({ type: "roomStatus", id: "s1", data: { status: "live" } })), 300);
  const lines = ["去挖点铁矿", "跳岩浆", "盖个房子给我看看", "大肥鱼今天吃白饭了吗", "666"];
  lines.forEach((content, index) => {
    setTimeout(() => {
      ws.send(JSON.stringify({
        id: `evt-${index + 1}`, roomId: "test", type: "chat", ts: Date.now(),
        user: { id: `u${index + 1}`, nickname: `观众${index + 1}` },
        data: { content },
      }));
    }, 500 + index * 600);
  });
});
