import AVFoundation
import Foundation

guard CommandLine.arguments.count == 2,
      let sampleRate = Double(CommandLine.arguments[1]),
      sampleRate > 0,
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: true
      ) else {
  fputs("invalid PCM stream format\n", stderr)
  exit(2)
}

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: format)

do {
  try engine.start()
} catch {
  fputs("audio engine failed: \(error)\n", stderr)
  exit(3)
}

let input = FileHandle.standardInput
let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
var playing = false

while true {
  let data = input.availableData
  if data.isEmpty { break }
  let frames = AVAudioFrameCount(data.count / Int(bytesPerFrame))
  guard frames > 0,
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
    fputs("invalid PCM chunk\n", stderr)
    exit(4)
  }
  buffer.frameLength = frames
  data.withUnsafeBytes { source in
    if let destination = buffer.audioBufferList.pointee.mBuffers.mData {
      memcpy(destination, source.baseAddress, Int(frames) * Int(bytesPerFrame))
    }
  }
  player.scheduleBuffer(buffer)
  if !playing {
    // AVAudioPlayerNode cannot start before its first scheduled buffer.
    player.play()
    playing = true
  }
}

guard playing else { exit(0) }

// A final silence buffer gives us a playback-complete callback after all
// preceding PCM frames have left the audio device.
guard let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1) else {
  fputs("cannot allocate PCM tail\n", stderr)
  exit(4)
}
tail.frameLength = 1
memset(tail.audioBufferList.pointee.mBuffers.mData, 0, Int(bytesPerFrame))
let done = DispatchSemaphore(value: 0)
player.scheduleBuffer(tail, completionHandler: { done.signal() })
done.wait()
player.stop()
engine.stop()
