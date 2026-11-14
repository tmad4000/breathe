import AVFoundation
import CoreImage
import ImageIO

protocol DualCameraDelegate: AnyObject {
    func dualCamera(_ camera: DualCamera, frontJPEG: Data, at seconds: Double)
    func dualCamera(_ camera: DualCamera, fingerRed red: Double, green: Double, blue: Double, at seconds: Double)
    func dualCamera(_ camera: DualCamera, note: String)
    func dualCamera(_ camera: DualCamera, failed message: String)
}

/// Front and rear cameras running together. The front camera's frames go out as small
/// JPEGs (for chest tracking in the page); the rear camera's frames are reduced to the
/// mean colour of their centre (a fingertip over the lens, lit by the torch).
final class DualCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    weak var delegate: DualCameraDelegate?

    private let session = AVCaptureMultiCamSession()
    private let sessionQueue = DispatchQueue(label: "breathe.camera.session")
    private let frontQueue = DispatchQueue(label: "breathe.camera.front")
    private let backQueue = DispatchQueue(label: "breathe.camera.back")
    private let frontOutput = AVCaptureVideoDataOutput()
    private let backOutput = AVCaptureVideoDataOutput()
    private var backDevice: AVCaptureDevice?
    private var configured = false
    private let ciContext = CIContext()
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

    // One front frame at a time: the next is encoded only after the page took the last.
    private let lock = NSLock()
    private var frameInFlight = false

    private enum Failure: Error { case unsupported, noCamera, cannotWire }

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(runtimeError(_:)), name: .AVCaptureSessionRuntimeError, object: session)
    }

    func start() {
        sessionQueue.async { [self] in
            do {
                if !configured { try configure(); configured = true }
            } catch {
                let message = (error as? Failure) == .unsupported
                    ? "This iPhone cannot run both cameras together. Use one of the other modes."
                    : "Could not start the cameras."
                delegate?.dualCamera(self, failed: message)
                return
            }
            setFrameInFlight(false)
            if !session.isRunning { session.startRunning() }
            setTorch(on: true)
        }
    }

    func stop() {
        sessionQueue.async { [self] in
            setTorch(on: false)
            if session.isRunning { session.stopRunning() }
        }
    }

    /// The page has taken the last front frame.
    func frameDelivered() { setFrameInFlight(false) }

    // MARK: Setup

    private func configure() throws {
        guard AVCaptureMultiCamSession.isMultiCamSupported else { throw Failure.unsupported }
        guard let front = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let back = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        else { throw Failure.noCamera }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        try wire(front, to: frontOutput, on: frontQueue, minWidth: 960)
        try wire(back, to: backOutput, on: backQueue, minWidth: 640)
        backDevice = back
    }

    private func wire(_ device: AVCaptureDevice, to output: AVCaptureVideoDataOutput,
                      on queue: DispatchQueue, minWidth: Int32) throws {
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw Failure.cannotWire }
        session.addInputWithNoConnections(input)

        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw Failure.cannotWire }
        session.addOutputWithNoConnections(output)

        guard let port = input.ports(for: .video, sourceDeviceType: device.deviceType,
                                     sourceDevicePosition: device.position).first
        else { throw Failure.cannotWire }
        let connection = AVCaptureConnection(inputPorts: [port], output: output)
        guard session.canAddConnection(connection) else { throw Failure.cannotWire }
        session.addConnection(connection)
        if connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false   // the page mirrors the preview itself
        }

        // Smallest format that runs alongside another camera at 30 fps and is wide enough.
        let width: (AVCaptureDevice.Format) -> Int32 = {
            CMVideoFormatDescriptionGetDimensions($0.formatDescription).width
        }
        let usable = device.formats
            .filter { format in
                format.isMultiCamSupported
                    && format.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }
            }
            .sorted { width($0) < width($1) }
        guard let format = usable.first(where: { width($0) >= minWidth }) ?? usable.last else { throw Failure.unsupported }
        try device.lockForConfiguration()
        device.activeFormat = format
        device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
        device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
        device.unlockForConfiguration()
    }

    private func setTorch(on: Bool) {
        guard let back = backDevice, back.hasTorch else {
            if on { delegate?.dualCamera(self, note: "No torch: use bright light behind your finger.") }
            return
        }
        do {
            try back.lockForConfiguration()
            defer { back.unlockForConfiguration() }
            if on {
                try back.setTorchModeOn(level: 0.4)   // enough light through a fingertip, less heat than full
                delegate?.dualCamera(self, note: "Torch on.")
            } else if back.isTorchActive {
                back.torchMode = .off
            }
        } catch {
            if on { delegate?.dualCamera(self, note: "Torch unavailable: use bright light behind your finger.") }
        }
    }

    @objc private func runtimeError(_ notification: Notification) {
        delegate?.dualCamera(self, failed: "The cameras stopped. Tap Stop, then Start.")
    }

    // MARK: Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let seconds = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        if output === backOutput {
            sendFingerColour(buffer, at: seconds)
        } else {
            sendFrontFrame(buffer, at: seconds)
        }
    }

    private func sendFingerColour(_ buffer: CVPixelBuffer, at seconds: Double) {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let pixels = base.assumingMemoryBound(to: UInt8.self)
        var red = 0, green = 0, blue = 0, count = 0
        // Centre half of the frame, every fourth pixel. Pixel order is BGRA.
        var y = height / 4
        while y < height * 3 / 4 {
            var x = width / 4
            while x < width * 3 / 4 {
                let offset = y * rowBytes + x * 4
                blue += Int(pixels[offset]); green += Int(pixels[offset + 1]); red += Int(pixels[offset + 2])
                count += 1
                x += 4
            }
            y += 4
        }
        guard count > 0 else { return }
        let n = Double(count)
        delegate?.dualCamera(self, fingerRed: Double(red) / n, green: Double(green) / n, blue: Double(blue) / n, at: seconds)
    }

    private func sendFrontFrame(_ buffer: CVPixelBuffer, at seconds: Double) {
        lock.lock()
        let busy = frameInFlight
        if !busy { frameInFlight = true }
        lock.unlock()
        if busy { return }

        var image = CIImage(cvPixelBuffer: buffer)
        if image.extent.width > image.extent.height { image = image.oriented(.right) }   // keep portrait
        let scale = 480 / image.extent.width
        if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = ciContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: [quality: 0.7]) else {
            setFrameInFlight(false)
            return
        }
        delegate?.dualCamera(self, frontJPEG: jpeg, at: seconds)
    }

    private func setFrameInFlight(_ value: Bool) {
        lock.lock(); frameInFlight = value; lock.unlock()
    }
}
