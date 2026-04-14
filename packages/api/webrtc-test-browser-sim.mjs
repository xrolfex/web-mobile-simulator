// This script simulates what a real browser does: 
// 1. Opens WebSocket to /ws/webrtc/:sessionId
// 2. Sends a manually-crafted SDP offer with recvonly (like a browser would)
// 3. Receives answer and ICE candidates
// 4. We DON'T try to establish actual media — we just verify the server 
//    responds correctly and starts sending RTP

import WebSocket from 'ws';

const SESSION_ID = '5d13fc2b-305e-4f0b-914b-2e68ea227de0';
const WS_URL = `ws://127.0.0.1:3000/ws/webrtc/${SESSION_ID}`;

// Craft a realistic browser-style SDP offer with recvonly
// This is what Chrome/Safari would send for pc.addTransceiver('video', {direction:'recvonly'})
const BROWSER_SDP_OFFER = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:abcd
a=ice-pwd:aabbccddeeffgghh11223344
a=ice-options:trickle
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=mid:0
a=recvonly
a=rtcp-mux
a=rtpmap:96 H264/90000
a=rtcp-fb:96 nack
a=rtcp-fb:96 nack pli
a=rtcp-fb:96 goog-remb
a=fmtp:96 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1
`;

console.log(`Connecting to ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('[BROWSER-SIM] WebSocket open — sending recvonly SDP offer');
  ws.send(JSON.stringify({ type: 'offer', sdp: BROWSER_SDP_OFFER }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'answer') {
    console.log('[BROWSER-SIM] Received SDP answer:');
    console.log(msg.sdp);
    
    // Check the direction
    if (msg.sdp.includes('a=sendonly')) {
      console.log('[BROWSER-SIM] ✅ Server correctly answered with sendonly');
    } else if (msg.sdp.includes('a=sendrecv')) {
      console.log('[BROWSER-SIM] ⚠️  Server answered with sendrecv (expected sendonly)');
    } else if (msg.sdp.includes('a=inactive')) {
      console.log('[BROWSER-SIM] ❌ Server answered with inactive — no media will flow!');
    }
    
    // Check for H.264 codec in answer
    if (msg.sdp.includes('H264') || msg.sdp.includes('h264')) {
      console.log('[BROWSER-SIM] ✅ H.264 codec present in answer');
    } else {
      console.log('[BROWSER-SIM] ❌ No H.264 codec in answer!');
    }
  } else if (msg.type === 'candidate') {
    console.log(`[BROWSER-SIM] ICE candidate: ${msg.candidate}`);
  } else if (msg.type === 'error') {
    console.error(`[BROWSER-SIM] Error: ${msg.message}`);
  }
});

ws.on('error', (err) => {
  console.error(`[BROWSER-SIM] WS error: ${err.message}`);
});

ws.on('close', (code) => {
  console.log(`[BROWSER-SIM] WS closed: code=${code}`);
});

// Close after 10 seconds
setTimeout(() => {
  console.log('[BROWSER-SIM] Closing...');
  ws.close();
  setTimeout(() => process.exit(0), 1000);
}, 10000);
