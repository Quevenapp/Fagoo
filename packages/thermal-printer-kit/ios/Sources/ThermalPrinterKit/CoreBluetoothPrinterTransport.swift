import CoreBluetooth
import Foundation

/**
 Delegate efêmero de um único trabalho BLE.

 O CoreBluetooth não inclui a geração do trabalho nos callbacks de `CBPeripheralDelegate`. Sem
 esta ponte, um callback atrasado do mesmo periférico poderia ser interpretado pelo cupom seguinte.
 */
private final class CoreBluetoothPrinterPeripheralDelegate: NSObject, CBPeripheralDelegate {
    weak var owner: CoreBluetoothPrinterTransport?
    let generation: UInt64

    init(owner: CoreBluetoothPrinterTransport, generation: UInt64) {
        self.owner = owner
        self.generation = generation
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        owner?.didDiscoverServices(peripheral, error: error, generation: generation)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        owner?.didDiscoverCharacteristics(
            peripheral,
            service: service,
            error: error,
            generation: generation
        )
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        owner?.didWriteValue(peripheral, error: error, generation: generation)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        owner?.peripheralIsReady(peripheral, generation: generation)
    }
}

/// Transporte BLE real. A busca precisa ser aberta — o filtro do sistema perde impressoras que só
/// publicam o serviço no scan response —, então a triagem por serviço de impressora acontece aqui,
/// e nenhum outro periférico chega à interface.
public final class CoreBluetoothPrinterTransport: NSObject, BluetoothPrinterTransporting {
    /**
     Como cada bloco chega à impressora, e o que a confirmação prova em cada caso.

     A diferença não é de desempenho, é de significado: `.withoutResponse` só prova que o rádio do
     iPhone aceitou o bloco, e a portátil 58mm descarta em silêncio o que passar do buffer dela.
     `.withResponse` espera o ATT da própria impressora, que assim dita o ritmo.
     */
    enum WriteMode: Equatable {
        case acknowledged
        case unacknowledged
    }

    /// A característica declara o que aceita, e nada mais implica isso — nem o serviço, nem o
    /// modelo. Escrita confirmada quando ela existe; sem resposta só quando é o único modo.
    static func writeMode(for properties: CBCharacteristicProperties) -> WriteMode {
        properties.contains(.write) ? .acknowledged : .unacknowledged
    }

    private enum JobPhase {
        case connecting
        case discoveringServices
        case discoveringCharacteristics
        case writing
        case flushing
        case disconnecting
    }

    /// Folga para a fila de escrita sem resposta drenar antes de soltar o periférico.
    private static let flushDelay: TimeInterval = 1.5
    /// Prazo apenas para abrir e descobrir a conexão, antes de qualquer escrita.
    private static let connectionSetupTimeout: TimeInterval = 15
    /// Reiniciado a cada progresso real; nunca limita a duração total de um cupom grande.
    private static let writingStagnationTimeout: TimeInterval = 15
    /// Último recurso depois de pedir cancelamento ao CoreBluetooth e não receber callback terminal.
    private static let teardownTimeout: TimeInterval = 5

    public var onStateChange: ((BluetoothPrinterRadioState) -> Void)?
    public var onCandidates: (([BluetoothPrinterCandidate]) -> Void)?

    /// Teto declarado pelo perfil em uso. Escrito pela tela e lido pela fila do rádio, então o
    /// acesso é protegido: o valor é copiado para o ritmo do trabalho no início de cada envio.
    private let ceilingLock = NSLock()
    private var declaredCeiling: Int?

    public var maxRasterBytesPerSecond: Int? {
        get {
            ceilingLock.lock()
            defer { ceilingLock.unlock() }
            return declaredCeiling
        }
        set {
            ceilingLock.lock()
            declaredCeiling = newValue
            ceilingLock.unlock()
        }
    }

    private lazy var central = CBCentralManager(delegate: self, queue: queue)
    private let queue = DispatchQueue(label: "br.com.thermalprinterkit.printer.ble")

    private var discovered: [(peripheral: CBPeripheral, id: Int, advertisedName: String?)] = []
    private var nextCandidateID = 1
    private var wantsScan = false

    private var active: CBPeripheral?
    private var characteristic: CBCharacteristic?
    private var pendingPayload: Data?
    private var pendingCompletion: ((ThermalPrintResult) -> Void)?
    private var payloadOffset = 0
    /// Armado no início de cada trabalho com o teto do perfil daquele cupom.
    private var pacer = RasterThroughputPacer(bytesPerSecond: nil)
    private var writeStarted = false
    private var awaitingWriteAck = false
    private var flushWorkItem: DispatchWorkItem?
    private var connectionTimeoutWorkItem: DispatchWorkItem?
    private var stagnationTimeoutWorkItem: DispatchWorkItem?
    private var teardownTimeoutWorkItem: DispatchWorkItem?
    private var stagnationEpoch: UInt64 = 0
    private var finishingResult: ThermalPrintResult?
    private var pendingCharacteristicDiscoveries = 0
    private var jobGeneration: UInt64 = 0
    private var jobPhase: JobPhase?
    private var peripheralDelegate: CoreBluetoothPrinterPeripheralDelegate?
    /// Um periférico cujo teardown expirou não pode ser reutilizado até o callback atrasado chegar.
    private var quarantinedPeripheralIdentifiers: Set<UUID> = []

    public func startScan() {
        queue.async { [weak self] in
            guard let self else { return }
            self.discovered = []
            self.nextCandidateID = 1
            // O rádio sobe de forma assíncrona: na primeira busca o manager acaba de ser criado
            // e ainda está em `.unknown`. A intenção fica registrada e o delegate retoma.
            self.wantsScan = true
            self.beginScanIfReady()
        }
    }

    public func stopScan() {
        queue.async { [weak self] in
            guard let self else { return }
            self.wantsScan = false
            guard self.central.state == .poweredOn else { return }
            self.central.stopScan()
        }
    }

    private func beginScanIfReady() {
        guard wantsScan, central.state == .poweredOn else { return }
        // O filtro do sistema só casa serviço presente no pacote de anúncio, e boa parte das
        // impressoras publica o serviço apenas no scan response. A busca é aberta e a triagem
        // acontece aqui: periférico que não anuncia serviço de impressora é descartado na hora
        // e nunca chega à interface.
        central.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    public func disconnect() {
        queue.async { [weak self] in
            guard let self else { return }
            // Reset/descarte durante um trabalho também precisa encerrar o resultado pendente.
            // Deixar apenas o callback de desconexão decidir abriria uma corrida com a janela de
            // dreno: o timer poderia responder `delivered` depois de a própria chamada cancelar.
            if self.pendingCompletion != nil {
                self.finishFailure("O envio Bluetooth foi interrompido.")
            } else {
                self.release()
            }
        }
    }

    public func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate,
        completion: @escaping (ThermalPrintResult) -> Void
    ) {
        queue.async { [weak self] in
            guard let self else {
                return completion(.failed(
                    message: "A impressora Bluetooth não está disponível.",
                    delivery: .notSent
                ))
            }
            guard let peripheral = self.discovered.first(where: { $0.id == candidate.id })?.peripheral else {
                return completion(.failed(
                    message: "A impressora Bluetooth não foi reencontrada.",
                    delivery: .notSent
                ))
            }
            guard !self.quarantinedPeripheralIdentifiers.contains(peripheral.identifier) else {
                return completion(.failed(
                    message: "A conexão Bluetooth anterior ainda está sendo encerrada.",
                    delivery: .notSent
                ))
            }
            guard self.pendingCompletion == nil else {
                return completion(.failed(
                    message: "A impressora Bluetooth já está recebendo outro trabalho.",
                    delivery: .notSent
                ))
            }
            self.pendingPayload = payload
            self.pendingCompletion = completion
            self.payloadOffset = 0
            // O ritmo é deste cupom: o teto vale a partir do próximo trabalho, e não no meio de um
            // que já está soltando bloco.
            self.pacer = RasterThroughputPacer(bytesPerSecond: self.maxRasterBytesPerSecond)
            self.writeStarted = false
            self.awaitingWriteAck = false
            self.flushWorkItem = nil
            self.finishingResult = nil
            self.pendingCharacteristicDiscoveries = 0
            self.jobGeneration &+= 1
            self.jobPhase = .connecting
            self.active = peripheral
            let delegate = CoreBluetoothPrinterPeripheralDelegate(
                owner: self,
                generation: self.jobGeneration
            )
            self.peripheralDelegate = delegate
            peripheral.delegate = delegate
            self.scheduleConnectionTimeout(
                for: self.jobGeneration,
                peripheral: peripheral
            )
            if peripheral.state == .connected {
                if self.characteristic != nil {
                    self.beginWriting(peripheral: peripheral, generation: self.jobGeneration)
                } else {
                    // Uma conexão preexistente não produz outro `didConnect`. Começar a descoberta
                    // aqui evita deixar o trabalho esperando até o timeout por um callback impossível.
                    self.jobPhase = .discoveringServices
                    peripheral.discoverServices(BluetoothPrinterProfile.services)
                }
            } else {
                self.central.connect(peripheral, options: nil)
            }
        }
    }

    /// Solta o periférico ao terminar. Impressora BLE para de anunciar enquanto está conectada,
    /// então segurar a conexão a esconde de todos os outros aparelhos do balcão — e do próprio
    /// app, na busca seguinte.
    private func finish(_ result: ThermalPrintResult) {
        guard pendingCompletion != nil, finishingResult == nil else { return }
        flushWorkItem?.cancel()
        flushWorkItem = nil
        connectionTimeoutWorkItem?.cancel()
        connectionTimeoutWorkItem = nil
        cancelWritingStagnationTimeout()
        if let peripheral = active, peripheral.state != .disconnected {
            // A fila só recebe o resultado depois de `didDisconnect`. Liberá-la antes permitiria
            // que o callback desta conexão antiga encerrasse o próximo cupom no mesmo peripheral.
            finishingResult = result
            jobPhase = .disconnecting
            characteristic = nil
            central.cancelPeripheralConnection(peripheral)
            scheduleTeardownTimeout(for: jobGeneration, peripheral: peripheral)
            return
        }
        complete(result)
    }

    private func complete(_ result: ThermalPrintResult) {
        flushWorkItem?.cancel()
        flushWorkItem = nil
        connectionTimeoutWorkItem?.cancel()
        connectionTimeoutWorkItem = nil
        teardownTimeoutWorkItem?.cancel()
        teardownTimeoutWorkItem = nil
        cancelWritingStagnationTimeout()
        let completion = pendingCompletion
        pendingCompletion = nil
        pendingPayload = nil
        payloadOffset = 0
        writeStarted = false
        finishingResult = nil
        pendingCharacteristicDiscoveries = 0
        jobPhase = nil
        active?.delegate = nil
        peripheralDelegate = nil
        active = nil
        characteristic = nil
        completion?(result)
    }

    private func completeAfterConnectionEnded(
        _ message: String,
        peripheral: CBPeripheral,
        generation: UInt64
    ) {
        guard active === peripheral,
              generation == jobGeneration,
              peripheralDelegate?.generation == generation,
              pendingCompletion != nil
        else { return }
        characteristic = nil
        if let result = finishingResult {
            complete(result)
        } else if pendingCompletion != nil {
            complete(.failed(
                message: message,
                delivery: Self.deliveryForFailure(writeStarted: writeStarted)
            ))
        } else {
            active = nil
        }
    }

    private func finishFailure(_ message: String) {
        finish(.failed(
            message: message,
            delivery: Self.deliveryForFailure(writeStarted: writeStarted)
        ))
    }

    /// Fronteira testável: antes do primeiro `writeValue` é seguro afirmar que nada foi enviado;
    /// depois dele, uma queda nunca pode autorizar repetição automática.
    static func deliveryForFailure(writeStarted: Bool) -> ThermalPrintDelivery {
        writeStarted ? .indeterminate : .notSent
    }

    private func release() {
        guard let peripheral = active else { return }
        active = nil
        characteristic = nil
        jobPhase = nil
        peripheral.delegate = nil
        peripheralDelegate = nil
        connectionTimeoutWorkItem?.cancel()
        connectionTimeoutWorkItem = nil
        teardownTimeoutWorkItem?.cancel()
        teardownTimeoutWorkItem = nil
        cancelWritingStagnationTimeout()
        central.cancelPeripheralConnection(peripheral)
    }

    /**
     `writeWithoutResponse` só confirma que o CoreBluetooth aceitou cada bloco. A conclusão final
     espera a mesma janela física já homologada; uma queda durante essa janela continua sendo
     indeterminada, nunca entrega nem nova tentativa automática.
     */
    private func finishAfterFlush() {
        guard flushWorkItem == nil,
              jobPhase == .flushing,
              let peripheral = active
        else { return }
        let generation = jobGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  self.isCurrent(
                    peripheral: peripheral,
                    generation: generation,
                    phase: .flushing
                  )
            else { return }
            self.finish(.delivered)
        }
        flushWorkItem = work
        queue.asyncAfter(deadline: .now() + Self.flushDelay, execute: work)
    }

    private func scheduleConnectionTimeout(
        for generation: UInt64,
        peripheral: CBPeripheral
    ) {
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  self.isCurrentConnectionSetup(
                    peripheral: peripheral,
                    generation: generation
                  )
            else { return }
            self.finishFailure("A impressora Bluetooth não concluiu a conexão a tempo.")
        }
        connectionTimeoutWorkItem = work
        queue.asyncAfter(deadline: .now() + Self.connectionSetupTimeout, execute: work)
    }

    private func scheduleTeardownTimeout(
        for generation: UInt64,
        peripheral: CBPeripheral
    ) {
        teardownTimeoutWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  Self.teardownTimeoutMatches(
                    scheduledGeneration: generation,
                    currentGeneration: self.jobGeneration,
                    isDisconnecting: self.jobPhase == .disconnecting
                  ),
                  self.active === peripheral,
                  self.peripheralDelegate?.generation == generation,
                  self.pendingCompletion != nil,
                  let result = self.finishingResult
            else { return }
            // O timeout é um terminal explícito da camada. Como o sistema não confirmou o fim
            // físico, o mesmo objeto fica em quarentena para um callback tardio não atingir o job
            // seguinte. O resultado original permanece intacto.
            self.quarantinedPeripheralIdentifiers.insert(peripheral.identifier)
            self.discovered.removeAll { $0.peripheral === peripheral }
            peripheral.delegate = nil
            self.central.cancelPeripheralConnection(peripheral)
            self.complete(result)
        }
        teardownTimeoutWorkItem = work
        queue.asyncAfter(deadline: .now() + Self.teardownTimeout, execute: work)
    }

    /// Fronteira testável do watchdog: timeout de uma geração anterior nunca libera a fila atual.
    static func teardownTimeoutMatches(
        scheduledGeneration: UInt64,
        currentGeneration: UInt64,
        isDisconnecting: Bool
    ) -> Bool {
        isDisconnecting && scheduledGeneration == currentGeneration
    }

    private func beginWriting(peripheral: CBPeripheral, generation: UInt64) {
        guard isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .discoveringCharacteristics
        ) || isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .connecting
        ) else { return }

        // O limite existe somente para conexão/descoberta. Raster grande pode bloquear e retomar
        // legitimamente pelo controle de fluxo do CoreBluetooth por mais de 15 segundos.
        connectionTimeoutWorkItem?.cancel()
        connectionTimeoutWorkItem = nil
        jobPhase = .writing
        pump()
    }

    /// Watchdog de falta de progresso, não deadline do cupom. Ele só existe enquanto o rádio
    /// recusa o próximo bloco, sem acumular um item cancelado para cada fragmento do raster.
    private func scheduleWritingStagnationTimeout(
        peripheral: CBPeripheral,
        generation: UInt64
    ) {
        guard isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .writing
        ) else { return }
        stagnationTimeoutWorkItem?.cancel()
        stagnationEpoch &+= 1
        let epoch = stagnationEpoch
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  self.stagnationEpoch == epoch,
                  self.isCurrent(
                    peripheral: peripheral,
                    generation: generation,
                    phase: .writing
                  )
            else { return }
            self.finishFailure("A impressora Bluetooth parou de aceitar dados.")
        }
        stagnationTimeoutWorkItem = work
        queue.asyncAfter(deadline: .now() + Self.writingStagnationTimeout, execute: work)
    }

    private func cancelWritingStagnationTimeout() {
        stagnationTimeoutWorkItem?.cancel()
        stagnationTimeoutWorkItem = nil
        // `DispatchWorkItem.cancel()` não é barreira. O epoch invalida um timer antigo que já
        // tenha entrado na fila antes do cancelamento.
        stagnationEpoch &+= 1
    }

    private func isCurrent(
        peripheral: CBPeripheral,
        generation: UInt64,
        phase: JobPhase
    ) -> Bool {
        active === peripheral &&
            jobGeneration == generation &&
            jobPhase == phase &&
            pendingCompletion != nil &&
            finishingResult == nil
    }

    private func isCurrentConnectionSetup(
        peripheral: CBPeripheral,
        generation: UInt64
    ) -> Bool {
        guard active === peripheral,
              jobGeneration == generation,
              pendingCompletion != nil,
              finishingResult == nil
        else { return false }
        return jobPhase == .connecting ||
            jobPhase == .discoveringServices ||
            jobPhase == .discoveringCharacteristics
    }

    /**
     BLE não tem controle de fluxo próprio, e "esperar o rádio liberar" não é a mesma coisa que a
     impressora ter recebido.

     `canSendWriteWithoutResponse` fala pela fila do iPhone: ela vaga rápido, o rádio segue no
     ritmo do enlace mesmo com o buffer da impressora cheio, e o excedente some sem erro. Em cupom
     curto isso passa; numa foto o descarte cai dentro de uma faixa `GS v 0` e o resto do raster
     volta a ser lido como texto — foi assim que o iPhone 7 imprimiu metade do cachorro e o
     restante em códigos, com a mesma MTP-II que o Android acertou depois da correção. No modo
     confirmado cada bloco espera `didWriteValueFor`, que vem do ATT da impressora.
     */
    /// Relógio monotônico: o ritmo não pode ser afetado por ajuste de hora do sistema no meio de
    /// uma foto.
    private static func now() -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    }

    /**
     Retoma o envio quando o teto liberar o próximo bloco.

     O watchdog de estagnação fica de fora de propósito: aqui não há recusa do rádio nem espera pela
     impressora, e sim uma pausa que este lado escolheu. Armá-lo transformaria um teto baixo em
     "a impressora parou de aceitar dados".
     */
    private func schedulePacedPump(
        after delay: TimeInterval,
        peripheral: CBPeripheral,
        generation: UInt64
    ) {
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self,
                  self.isCurrent(peripheral: peripheral, generation: generation, phase: .writing)
            else { return }
            self.pump()
        }
    }

    private func pump() {
        guard jobPhase == .writing,
              let peripheral = active,
              let target = characteristic,
              let payload = pendingPayload
        else { return }
        // O limite é sempre o do pacote único. `maximumWriteValueLength(for: .withResponse)`
        // devolve 512 e joga o CoreBluetooth na escrita preparada, que essas portáteis não
        // implementam — trocar perda silenciosa por outra não é conserto.
        let limit = max(20, peripheral.maximumWriteValueLength(for: .withoutResponse))
        switch Self.writeMode(for: target.properties) {
        case .acknowledged:
            guard !awaitingWriteAck else { return }
            guard payloadOffset < payload.count else {
                cancelWritingStagnationTimeout()
                jobPhase = .flushing
                return finishAfterFlush()
            }
            let end = min(payloadOffset + limit, payload.count)
            // O freio entra onde os blocos já saem, antes de soltar este. Vale também no modo
            // confirmado: o callback do ATT prova recepção no rádio, não impressão, e é entre
            // receber e imprimir que a T210 descarta linha.
            let pausa = pacer.delay(at: Self.now())
            guard pausa <= 0 else {
                return schedulePacedPump(after: pausa, peripheral: peripheral, generation: jobGeneration)
            }
            peripheral.writeValue(
                payload.subdata(in: payloadOffset..<end),
                for: target,
                type: .withResponse
            )
            pacer.recordChunk(bytes: end - payloadOffset, at: Self.now())
            payloadOffset = end
            writeStarted = true
            awaitingWriteAck = true
            // O watchdog passa a cobrir a espera pela impressora, não a recusa do rádio.
            scheduleWritingStagnationTimeout(
                peripheral: peripheral,
                generation: jobGeneration
            )
        case .unacknowledged:
            while payloadOffset < payload.count {
                guard peripheral.canSendWriteWithoutResponse else {
                    scheduleWritingStagnationTimeout(
                        peripheral: peripheral,
                        generation: jobGeneration
                    )
                    return
                }
                let pausa = pacer.delay(at: Self.now())
                guard pausa <= 0 else {
                    // Sai do laço em vez de dormir nele: esta é a fila do CoreBluetooth, e segurá-la
                    // travaria os próprios callbacks que fazem o cupom avançar.
                    return schedulePacedPump(
                        after: pausa,
                        peripheral: peripheral,
                        generation: jobGeneration
                    )
                }
                let end = min(payloadOffset + limit, payload.count)
                peripheral.writeValue(
                    payload.subdata(in: payloadOffset..<end),
                    for: target,
                    type: .withoutResponse
                )
                pacer.recordChunk(bytes: end - payloadOffset, at: Self.now())
                payloadOffset = end
                writeStarted = true
            }
            cancelWritingStagnationTimeout()
            jobPhase = .flushing
            finishAfterFlush()
        }
    }
}

extension CoreBluetoothPrinterTransport: CBCentralManagerDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            onStateChange?(.ready)
            beginScanIfReady()
        case .unauthorized:
            onStateChange?(.unauthorized)
        case .poweredOff:
            onStateChange?(.poweredOff)
        default:
            onStateChange?(.unknown)
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard !quarantinedPeripheralIdentifiers.contains(peripheral.identifier) else { return }
        let advertised = Self.advertisedServices(advertisementData)
        guard advertised.contains(where: BluetoothPrinterProfile.services.contains) else { return }
        guard !discovered.contains(where: { $0.peripheral.identifier == peripheral.identifier }) else { return }
        // O nome anunciado é o que a pessoa reconhece na mesa — "MTP-II_BD7E", "T210_D0E9". Sem
        // ele a lista virava "Impressora Bluetooth 1" e "2", e escolher entre duas viradas para
        // cima é adivinhação. O Android já mostrava o nome real; era divergência.
        let advertisedName =
            (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
        discovered.append((peripheral, nextCandidateID, advertisedName))
        nextCandidateID += 1
        publishCandidates()
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        if quarantinedPeripheralIdentifiers.contains(peripheral.identifier) {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        guard active === peripheral,
              peripheral.state == .connected,
              pendingCompletion != nil,
              finishingResult == nil,
              jobPhase == .connecting,
              let peripheralDelegate,
              peripheralDelegate.generation == jobGeneration
        else {
            // `connect` pode concluir depois de reset/timeout. Sem trabalho atual, manter esse
            // periférico conectado o esconderia de novas buscas e deixaria recurso vivo.
            central.cancelPeripheralConnection(peripheral)
            return
        }
        jobPhase = .discoveringServices
        peripheral.delegate = peripheralDelegate
        peripheral.discoverServices(BluetoothPrinterProfile.services)
    }

    public func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        if quarantinedPeripheralIdentifiers.remove(peripheral.identifier) != nil { return }
        guard let generation = currentGeneration(for: peripheral),
              peripheral.state == .disconnected,
              jobPhase == .connecting || jobPhase == .disconnecting
        else { return }
        completeAfterConnectionEnded(
            "Não foi possível conectar à impressora Bluetooth.",
            peripheral: peripheral,
            generation: generation
        )
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        if quarantinedPeripheralIdentifiers.remove(peripheral.identifier) != nil { return }
        guard let generation = currentGeneration(for: peripheral),
              peripheral.state == .disconnected,
              jobPhase != nil,
              jobPhase != .connecting
        else { return }
        completeAfterConnectionEnded(
            "A conexão Bluetooth caiu durante o envio.",
            peripheral: peripheral,
            generation: generation
        )
    }

    private func currentGeneration(for peripheral: CBPeripheral) -> UInt64? {
        guard active === peripheral,
              pendingCompletion != nil,
              let generation = peripheralDelegate?.generation,
              generation == jobGeneration
        else { return nil }
        return generation
    }

    /// O serviço pode vir na lista principal ou na de overflow, quando o anúncio lota.
    private static func advertisedServices(_ advertisementData: [String: Any]) -> [CBUUID] {
        let primary = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let overflow = advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? []
        return primary + overflow
    }

    private func publishCandidates() {
        let list = discovered.enumerated().map { index, entry in
            BluetoothPrinterCandidate(
                id: entry.id,
                label: Self.candidateLabel(entry.advertisedName, position: index + 1),
                declaredName: Self.declaredName(entry.advertisedName),
                // O `id` posicional some junto com a varredura. Quem sobrevive a reabrir o app é
                // este identificador, e é ele que a adoção guarda para reencontrar a mesma
                // impressora — nunca o nome anunciado, que duas unidades do mesmo modelo repetem.
                peripheralIdentifier: entry.peripheral.identifier
            )
        }
        onCandidates?(list)
    }

    /// Nome anunciado quando ele existe e não é identificador técnico; numeração só como último
    /// recurso. `sanitizeField` é o mesmo filtro que guarda o nome de perfil: MAC, IP e UUID não
    /// chegam à tela nem ao papel.
    static func candidateLabel(_ advertisedName: String?, position: Int) -> String {
        declaredName(advertisedName) ?? "Impressora Bluetooth \(position)"
    }

    /// Nulo quando o aparelho não se identificou ou o nome é identificador técnico. A numeração
    /// serve para a tela; para batizar um perfil, só o nome de verdade.
    static func declaredName(_ advertisedName: String?) -> String? {
        guard let advertisedName,
              let limpo = PrinterDeclaredIdentity.sanitizeField(Data(advertisedName.utf8)),
              !limpo.isEmpty
        else { return nil }
        return limpo
    }
}

extension CoreBluetoothPrinterTransport {
    fileprivate func didDiscoverServices(
        _ peripheral: CBPeripheral,
        error: Error?,
        generation: UInt64
    ) {
        guard isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .discoveringServices
        ) else { return }
        guard error == nil, let services = peripheral.services, !services.isEmpty else {
            return finishFailure("A impressora Bluetooth não expôs o serviço de impressão.")
        }
        jobPhase = .discoveringCharacteristics
        pendingCharacteristicDiscoveries = services.count
        for service in services {
            peripheral.discoverCharacteristics(
                BluetoothPrinterProfile.characteristics(for: service.uuid),
                for: service
            )
        }
    }

    fileprivate func didDiscoverCharacteristics(
        _ peripheral: CBPeripheral,
        service: CBService,
        error: Error?,
        generation: UInt64
    ) {
        guard isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .discoveringCharacteristics
        ) else { return }
        guard error == nil else {
            return completeCharacteristicDiscoveryWithoutTarget()
        }
        guard characteristic == nil else { return }
        let wanted = BluetoothPrinterProfile.characteristics(for: service.uuid)
        guard let target = service.characteristics?.first(where: { wanted.contains($0.uuid) }) else {
            return completeCharacteristicDiscoveryWithoutTarget()
        }
        pendingCharacteristicDiscoveries = 0
        characteristic = target
        beginWriting(peripheral: peripheral, generation: generation)
    }

    fileprivate func didWriteValue(_ peripheral: CBPeripheral, error: Error?, generation: UInt64) {
        guard isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .writing
        ) else { return }
        awaitingWriteAck = false
        cancelWritingStagnationTimeout()
        guard error == nil else {
            // Recusa no meio do cupom não autoriza reenvio: parte do raster já saiu no papel.
            return finishFailure("A impressora Bluetooth recusou um bloco do cupom.")
        }
        pump()
    }

    fileprivate func peripheralIsReady(_ peripheral: CBPeripheral, generation: UInt64) {
        guard isCurrent(
            peripheral: peripheral,
            generation: generation,
            phase: .writing
        ) else { return }
        // Este callback pertence ao fluxo sem confirmação. No modo confirmado quem retoma é
        // `didWriteValueFor`, e cancelar o watchdog aqui deixaria a espera sem rede.
        guard let target = characteristic,
              Self.writeMode(for: target.properties) == .unacknowledged
        else { return }
        cancelWritingStagnationTimeout()
        pump()
    }

    private func completeCharacteristicDiscoveryWithoutTarget() {
        pendingCharacteristicDiscoveries = max(0, pendingCharacteristicDiscoveries - 1)
        if pendingCharacteristicDiscoveries == 0 {
            finishFailure("A impressora Bluetooth não expôs a característica de escrita.")
        }
    }
}
