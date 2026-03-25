/**
 * Canonical Circuit Loader
 *
 * Loads circuits directly from the canonical JSON format into the
 * CircuitVerse simulator.
 *
 * The canonical format contains all information needed to reconstruct
 * a logically correct and visually positioned circuit:
 *   - Component types, properties, labels
 *   - Net-based connectivity (which ports connect to which)
 *   - Visual positions (x, y, direction) for every component
 *   - Layout metadata, interface ports, subcircuit instances
 *
 * This loader creates modules via their constructors (which auto-generate
 * nodes at correct positions), then wires them up using net data.
 *
 * @module loadCanonical
 */

import { resetScopeList, newCircuit, switchCircuit } from '../../circuit'
import { setProjectName } from '../save'
import { scheduleUpdate, update, updateSimulationSet, updateCanvasSet, gridUpdateSet } from '../../engine'
import { updateRestrictedElementsInScope } from '../../restrictedElementDiv'
import { simulationArea } from '../../simulationArea'
import { scheduleBackup } from '../backupCircuit'
import { showProperties } from '../../ux'
import modules from '../../modules'
import Node from '../../node'
import { oppositeDirection, fixDirection } from '../../canvasApi'
import plotArea from '../../plotArea'
import { TestbenchData } from '#/simulator/src/testbench'
import { SimulatorStore } from '#/store/SimulatorStore/SimulatorStore'
import { toRefs } from 'vue'
import SubCircuit from '../../subcircuit'
import { generateId } from '../../utils'

/**
 * Build constructor parameters from canonical component properties and direction.
 *
 * Each module constructor expects: (x, y, scope, direction, ...typeSpecificParams)
 * This function produces the [direction, ...typeSpecificParams] array.
 *
 * @param {Object} comp - Canonical component object
 * @param {string} direction - Visual direction (RIGHT, LEFT, UP, DOWN)
 * @returns {Array} Constructor parameters
 */
function buildConstructorParams(comp, direction) {
    const props = comp.properties || {}
    const dir = direction || 'RIGHT'

    switch (comp.type) {
        case 'Input':
        case 'Output':
            return [dir, props.bitWidth || 1, {}]
        case 'AndGate':
        case 'OrGate':
        case 'NandGate':
        case 'NorGate':
        case 'XorGate':
        case 'XnorGate':
            return [dir, props.inputSize || 2, props.bitWidth || 1]
        case 'NotGate':
        case 'Buffer':
            return [dir, props.bitWidth || 1]
        case 'DflipFlop':
        case 'TflipFlop':
        case 'JKflipFlop':
        case 'SRflipFlop':
        case 'Dlatch':
            return [dir, props.bitWidth || 1]
        case 'TriState':
        case 'ControlledInverter':
            return [dir, props.bitWidth || 1]
        case 'Multiplexer':
        case 'Demultiplexer':
        case 'Decoder':
        case 'PriorityEncoder':
            return [dir, props.bitWidth || 1, props.controlSignalSize || 1]
        case 'RAM':
        case 'EEPROM':
        case 'Rom':
            return [dir, props.bitWidth || 8, props.addressWidth || 8]
        case 'Splitter':
            return [dir, props.bitWidth || 1, props.bitWidthSplit || 1]
        case 'Adder':
        case 'ALU':
        case 'TwoComplement':
            return [dir, props.bitWidth || 1]
        case 'Clock':
            return [dir]
        case 'ConstantVal':
            return [dir, props.bitWidth || 1, props.value || 0]
        case 'Stepper':
            return [dir, props.bitWidth || 1]
        case 'Tunnel':
            return [dir, props.bitWidth || 1, props.identifier || '']
        case 'Flag':
        case 'BitSelector':
        case 'MSB':
        case 'LSB':
            return [dir, props.bitWidth || 1]
        case 'Counter':
            return [dir, props.bitWidth || 1, props.maxValue]
        case 'Random':
            return [dir, props.bitWidth || 1, props.maxValue]
        case 'TTY':
            return [dir, props.rows || 1, props.cols || 16]
        case 'Keyboard':
            return [dir, props.rows || 1, props.cols || 16, props.bufferSize || 32]
        case 'SevenSegDisplay':
        case 'SixteenSegDisplay':
        case 'HexDisplay':
        case 'DigitalLed':
        case 'VariableLed':
        case 'RGBLed':
        case 'SquareRGBLed':
        case 'Button':
        case 'Power':
        case 'Ground':
            return [dir]
        case 'RGBLedMatrix':
            return [dir, props.rows || 8, props.columns || 8]
        case 'ForceGate':
            return [dir, props.bitWidth || 1]
        case 'TB_Input':
        case 'TB_Output':
            return [dir, props.bitWidth || 1, props.identifier || '']
        default:
            // For unknown/generic types, use constructorParams if available
            if (props.constructorParams) {
                return props.constructorParams
            }
            return [dir]
    }
}

/**
 * Connect a list of nodes as a chain while avoiding duplicate connections.
 *
 * @param {Array<Node>} nodes - Ordered list of nodes to connect
 */
function connectNodeChain(nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
        if (!nodes[i].connections.includes(nodes[i + 1])) {
            nodes[i].connect(nodes[i + 1])
        }
    }
}

/**
 * Load a single canonical circuit into a scope.
 *
 * Creates all components via module constructors, maps canonical port IDs
 * to actual Node objects, creates subcircuit instances, then wires
 * everything up using net connectivity data.
 *
 * @param {Scope} scope - The scope to populate
 * @param {Object} circuit - Canonical circuit object
 * @param {Object} circuitIdToScopeId - Map of canonical circuit IDs → numeric scope IDs
 */
function loadCanonicalCircuit(scope, circuit, circuitIdToScopeId) {
    // Map from canonical port ID (e.g. "AndGate_0.inp.0") → actual Node object
    const portNodeMap = {}

    const visual = circuit.visual || {}

    // Visual data for component positioning
    const componentVisuals = visual.components || {}

    // 1. Create all logic components
    for (const comp of circuit.netlist.components) {
        const type = comp.type

        // Skip if module type doesn't exist in the simulator
        if (!modules[type]) {
            console.warn(`[loadCanonical] Unknown module type: ${type}, skipping`)
            continue
        }

        const vis = componentVisuals[comp.id] || {}
        const x = vis.x || 0
        const y = vis.y || 0
        const direction = vis.direction || 'RIGHT'

        // Build constructor params from canonical properties
        const constructorParams = buildConstructorParams(comp, direction)

        // Create the module
        const obj = new modules[type](x, y, scope, ...constructorParams)

        // Set label and direction
        obj.label = comp.label || ''
        obj.labelDirection =
            vis.labelDirection ||
            oppositeDirection[fixDirection[obj.direction]] ||
            'LEFT'

        // Set propagation delay
        if (comp.properties && comp.properties.propagationDelay) {
            obj.propagationDelay = comp.properties.propagationDelay
        }

        obj.fixDirection()

        // Restore state values (e.g., input state, ROM data)
        if (comp.state) {
            for (const prop in comp.state) {
                obj[prop] = comp.state[prop]
            }
        }

        // Restore subcircuitMetadata if present
        if (comp.subcircuitMetadata) {
            obj.subcircuitMetadata = comp.subcircuitMetadata
        }

        // Map canonical port IDs → actual Node objects on the created module
        if (comp.ports) {
            for (const [portName, portRef] of Object.entries(comp.ports)) {
                if (Array.isArray(portRef)) {
                    // Array port (e.g., inp: ["AndGate_0.inp.0", "AndGate_0.inp.1"])
                    for (let i = 0; i < portRef.length; i++) {
                        if (obj[portName] && obj[portName][i]) {
                            portNodeMap[portRef[i]] = obj[portName][i]
                        }
                    }
                } else {
                    // Single port (e.g., output1: "Input_0.output1")
                    if (obj[portName]) {
                        portNodeMap[portRef] = obj[portName]
                    }
                }
            }
        }
    }

    // 2. Create subcircuit instances
    if (circuit.netlist.subcircuitInstances) {
        const subVisuals = visual.subcircuits || {}

        for (const sub of circuit.netlist.subcircuitInstances) {
            const subVis = subVisuals[sub.id] || {}
            const scopeId = circuitIdToScopeId[sub.circuitId]

            if (scopeId === undefined) {
                console.warn(
                    `[loadCanonical] SubCircuit references unknown circuit: ${sub.circuitId}, skipping`
                )
                continue
            }

            // Create the SubCircuit instance (without savedData → auto-creates nodes)
            const subObj = new SubCircuit(
                subVis.x || 0,
                subVis.y || 0,
                scope,
                String(scopeId)
            )

            // Map canonical port IDs → the auto-created input/output nodes
            if (sub.inputPorts && subObj.inputNodes) {
                for (
                    let i = 0;
                    i < sub.inputPorts.length && i < subObj.inputNodes.length;
                    i++
                ) {
                    portNodeMap[sub.inputPorts[i]] = subObj.inputNodes[i]
                }
            }
            if (sub.outputPorts && subObj.outputNodes) {
                for (
                    let i = 0;
                    i < sub.outputPorts.length && i < subObj.outputNodes.length;
                    i++
                ) {
                    portNodeMap[sub.outputPorts[i]] = subObj.outputNodes[i]
                }
            }
        }
    }

    // 3. Wire up connections using hybrid approach
    //    If the canonical file includes intermediate node connectivity data,
    //    we create intermediate junction nodes and wire through them — this
    //    preserves the original wire routing (Manhattan layout, junction points).
    //    For nets not represented by intermediate nodes, we fall back to
    //    chain-connecting component ports directly.
    const intermediateNodeData =
        visual.intermediateNodes || []
    const hasIntermediateConnectivity = intermediateNodeData.some(
        (n) => n.connections && n.connections.length > 0
    )

    if (hasIntermediateConnectivity) {
        // Create intermediate (type 2) nodes at the stored positions
        const intermediateNodes = intermediateNodeData.map((ind) => {
            return new Node(
                ind.x,
                ind.y,
                2, // NODE_INTERMEDIATE
                scope.root,
                ind.bitWidth || 1,
                ind.label || ''
            )
        })

        // Build set of ports represented by intermediate nodes
        const representedPorts = new Set()
        for (const intData of intermediateNodeData) {
            if (!intData.connections) continue
            for (const conn of intData.connections) {
                if (conn.type === 'port') {
                    representedPorts.add(conn.id)
                }
            }
        }

        // Connect each intermediate to its neighbors (ports and other intermediates)
        for (let i = 0; i < intermediateNodeData.length; i++) {
            const intData = intermediateNodeData[i]
            if (!intData.connections) continue

            for (const conn of intData.connections) {
                let targetNode = null

                if (conn.type === 'port') {
                    targetNode = portNodeMap[conn.id]
                } else if (conn.type === 'intermediate') {
                    targetNode = intermediateNodes[conn.index]
                }

                if (
                    targetNode &&
                    !intermediateNodes[i].connections.includes(targetNode)
                ) {
                    intermediateNodes[i].connect(targetNode)
                }
            }
        }

        // Fallback: connect nets that are not represented by intermediate nodes
        for (const net of circuit.netlist.nets) {
            const unrepresentedPorts = net.connections
                .filter((portId) => !representedPorts.has(portId))
                .map((portId) => portNodeMap[portId])
                .filter((node) => node !== undefined)

            // If some ports are unrepresented, connect them directly
            connectNodeChain(unrepresentedPorts)
        }
    } else {
        // Fallback for canonical files without intermediate connectivity:
        // chain-connect component ports directly within each net.
        // This produces correct logical connections but simpler wire routing.
        for (const net of circuit.netlist.nets) {
            const nodes = net.connections
                .map((portId) => portNodeMap[portId])
                .filter((n) => n !== undefined)

            connectNodeChain(nodes)
        }
    }

    // 4. Restore restricted elements
    if (circuit.restrictedCircuitElementsUsed) {
        scope.restrictedCircuitElementsUsed =
            circuit.restrictedCircuitElementsUsed
    }

    // 5. Restore Verilog metadata
    if (circuit.verilogMetadata) {
        scope.verilogMetadata = circuit.verilogMetadata
    }

    // 6. Restore testbench data
    if (circuit.testbenchData) {
        scope.testbenchData = new TestbenchData(
            circuit.testbenchData.testData,
            circuit.testbenchData.currentGroup,
            circuit.testbenchData.currentCase
        )
    }

    // 7. Restore layout
    if (visual.layout) {
        scope.layout = {
            width: visual.layout.width || 100,
            height: visual.layout.height || 40,
            title_x: visual.layout.titleX || 50,
            title_y: visual.layout.titleY || 13,
            titleEnabled: visual.layout.titleEnabled !== false,
        }
    }

    // Backward compatibility for layout titleEnabled
    if (scope.layout.titleEnabled === undefined) {
        scope.layout.titleEnabled = true
    }
}

/**
 * Detect whether a JSON object is in canonical format.
 *
 * Checks for the canonical format signature: formatVersion, project, circuits.
 *
 * @param {Object} data - Parsed JSON object
 * @returns {boolean} True if the data is in canonical format
 */
export function isCanonicalFormat(data) {
    return (
        data &&
        typeof data === 'object' &&
        data.formatVersion === '1.0' &&
        data.project &&
        Array.isArray(data.circuits)
    )
}

/**
 * Load a project from canonical format JSON.
 *
 * This is the main entry point for loading canonical files.
 * It creates scopes for all circuits, loads components and wiring
 * from the canonical netlist/visual data, and restores the full
 * simulator state.
 *
 * @param {Object|string} canonicalData - Canonical JSON (object or string)
 * @exports loadCanonical
 */
export default function loadCanonical(canonicalData) {
    // Parse JSON string if needed
    if (typeof canonicalData === 'string') {
        canonicalData = JSON.parse(canonicalData)
    }

    const simulatorStore = SimulatorStore()
    const { circuit_list } = toRefs(simulatorStore)
    const isEmbedded = typeof embed !== 'undefined' && embed

    // Set project name
    setProjectName(
        canonicalData.project.name || canonicalData.project.projectId || 'Untitled'
    )

    // Reset workspace
    globalScope = undefined
    resetScopeList()

    // Build a map: canonical circuit ID → numeric scope ID.
    // Prefer originalId when available so focusedCircuitId/tabOrder map back
    // to the same runtime scope ids used in legacy saves.
    const circuitIdToScopeId = {}
    for (const circuit of canonicalData.circuits) {
        circuitIdToScopeId[circuit.id] =
            circuit.originalId !== undefined ? circuit.originalId : generateId()
    }

    // Load all circuits in order (subcircuits come first in canonical format)
    for (const circuit of canonicalData.circuits) {
        const scopeId = circuitIdToScopeId[circuit.id]

        // Check for Verilog circuit metadata
        let isVerilogCircuit = false
        let isMainCircuit = false
        if (circuit.verilogMetadata) {
            isVerilogCircuit = circuit.verilogMetadata.isVerilogCircuit
            isMainCircuit = circuit.verilogMetadata.isMainCircuit
        }

        // Create new circuit (scope)
        const scope = newCircuit(
            circuit.name || 'Untitled',
            scopeId,
            isVerilogCircuit,
            isMainCircuit
        )

        // Load circuit data from canonical format
        loadCanonicalCircuit(scope, circuit, circuitIdToScopeId)

        // Focus circuit
        globalScope = scope

        // Center the circuit
        globalScope.centerFocus(isEmbedded)

        // Update and backup
        update(globalScope, true)

        // Update restricted element list
        updateRestrictedElementsInScope()

        scheduleBackup()
    }

    // Restore clock settings
    simulationArea.changeClockTime(canonicalData.project.timePeriod || 500)
    simulationArea.clockEnabled =
        canonicalData.project.clockEnabled !== false

    // Show properties panel
    if (!isEmbedded) {
        showProperties(simulationArea.lastSelected)
    }

    // Reorder tabs according to saved tab order
    if (canonicalData.project.tabOrder) {
        const tabOrder = canonicalData.project.tabOrder.map(
            (id) => String(circuitIdToScopeId[id] || id)
        )
        const tabOrderIndex = new Map(tabOrder.map((id, index) => [id, index]))

        circuit_list.value.sort((a, b) => {
            const aIndex = tabOrderIndex.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER
            const bIndex = tabOrderIndex.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER
            return aIndex - bIndex
        })
    }

    // Switch to focused circuit
    if (canonicalData.project.focusedCircuitId) {
        const focusedScopeId =
            circuitIdToScopeId[canonicalData.project.focusedCircuitId]
        if (focusedScopeId) {
            switchCircuit(String(focusedScopeId))
        }
    } else if (canonicalData.circuits.length > 0) {
        // Default: switch to the last circuit (usually "Main")
        const lastCircuit =
            canonicalData.circuits[canonicalData.circuits.length - 1]
        const lastScopeId = circuitIdToScopeId[lastCircuit.id]
        if (lastScopeId) {
            switchCircuit(String(lastScopeId))
        }
    }

    // Trigger rendering updates
    updateSimulationSet(true)
    updateCanvasSet(true)
    gridUpdateSet(true)

    // Reset timing diagram
    if (!isEmbedded) {
        plotArea.reset()
    }

    scheduleUpdate(1)
}
