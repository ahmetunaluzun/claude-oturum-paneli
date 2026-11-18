// Dikte kaydı: mikrofondan gelen ham örnekleri ana iş parçacığına aktarır (app.js 16 kHz WAV'a çevirir).
class MicRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("mic-rec", MicRecorder);
