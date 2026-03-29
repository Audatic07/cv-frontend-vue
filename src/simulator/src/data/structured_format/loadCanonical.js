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

function buildConstructorParams(comp, direction) {
    const props = comp.properties || {};
    // Canonical keeps generic props, but constructors still expect ordered args.
    const dir = direction && typeof direction === 'string' ? direction : 'RIGHT';
    const bw = props.bitWidth || 1;
    switch (comp.type) {
        case 'Input':
        case 'Output':
            return [dir, bw, {}];
        case 'AndGate':
        case 'OrGate':
        case 'NandGate':
        case 'NorGate':
        case 'XorGate':
        case 'XnorGate':
            return [dir, props.inputSize || 2, bw];
        case 'NotGate':
        case 'Buffer':
        case 'TriState':
        case 'ControlledInverter':
        case 'DflipFlop':
        case 'TflipFlop':
        case 'JKflipFlop':
        case 'SRflipFlop':
        case 'Dlatch':
        case 'Adder':
        case 'ALU':
        case 'TwoComplement':
        case 'Stepper':
        case 'Flag':
        case 'BitSelector':
        case 'MSB':
        case 'LSB':
        case 'ForceGate':
            return [dir, bw];
        case 'Multiplexer':
        case 'Demultiplexer':
        case 'Decoder':
        case 'PriorityEncoder':
            return [dir, bw, props.controlSignalSize || 1];
        case 'RAM':
        case 'EEPROM':
        case 'Rom':
            return [dir, props.bitWidth || 8, props.addressWidth || 8];
        case 'Clock':
            return [dir];
        case 'ConstantVal': {
            const val = props.value !== undefined ? props.value : 0;
            return [dir, bw, val];
        }
        case 'Splitter':
            return [dir, bw, props.bitWidthSplit || 1];
        case 'Tunnel':
            return [dir, bw, props.identifier || ''];
        case 'Counter':
        case 'Random':
            return [dir, bw, props.maxValue];
        case 'TTY':
            return [dir, props.rows || 1, props.cols || 16];
        case 'Keyboard':
            return [dir, props.rows || 1, props.cols || 16, props.bufferSize || 32];
        case 'RGBLedMatrix':
            return [dir, props.rows || 8, props.columns || 8];
        case 'TB_Input':
        case 'TB_Output':
            return [dir, bw, props.identifier || ''];
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
            return [dir];
        default:
            throw new Error(`Unsupported component type in canonical file: ${comp.type}`);
    }
}

function connectNodeChain(nodes) {
    // Net data is endpoint order only, connect neighbors to rebuild the chain.
    if (nodes.length < 2) {
        return;
    }
    for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1];
        const b = nodes[i];
        if (!a.connections.includes(b)) {
            a.connect(b);
        }
    }
}

function loadCanonicalCircuit(scope, circuit, circuitIdToScopeId) {
    // canonical port id (Comp_0.out) to live Node object.
    const portNodeMap = {};
    const visual = circuit.visual || {};
    const componentVisuals = visual.components || {};
    const writePortMap = (obj, ports) => {
        // Some modules expose arrays (like inp[]), some expose single node refs.
        if (!ports) return;
        for (const [portName, portRef] of Object.entries(ports)) {
            if (Array.isArray(portRef)) {
                for (let i = 0; i < portRef.length; i++) {
                    if (!obj[portName] || !obj[portName][i]) continue;
                    portNodeMap[portRef[i]] = obj[portName][i];
                }
            } else {
                if (!obj[portName]) continue;
                portNodeMap[portRef] = obj[portName];
            }
        }
    };

    // Build regular components first so their pins exist before wiring.
    for (const comp of circuit.netlist.components) {
        const type = comp.type;
        if (!modules[type]) {
            throw new Error(`Unknown module type in canonical file: ${type}`);
        }
        const vis = componentVisuals[comp.id] || {};
        const x = vis.x || 0;
        const y = vis.y || 0;
        const direction = vis.direction || 'RIGHT';
        const constructorParams = buildConstructorParams(comp, direction);
        const obj = new modules[type](x, y, scope, ...constructorParams);
        // Label text and direction are visual-only, so restore them from visual data.
        obj.label = comp.label || '';
        obj.labelDirection = vis.labelDirection || oppositeDirection[fixDirection[obj.direction]] || 'LEFT';
        if (comp.properties && comp.properties.propagationDelay) {
            obj.propagationDelay = comp.properties.propagationDelay;
        }
        obj.fixDirection();
        if (comp.state) {
            Object.assign(obj, comp.state);
        }
        if (comp.subcircuitMetadata) {
            obj.subcircuitMetadata = comp.subcircuitMetadata;
        }
        writePortMap(obj, comp.ports);
    }

    // Then build subcircuits and register their exposed input/output nodes.
    const subVisuals = visual.subcircuits || {};
    for (const sub of circuit.netlist.subcircuitInstances || []) {
        const subVis = subVisuals[sub.id] || {};
        const scopeId = circuitIdToScopeId[sub.circuitId];
        if (scopeId === undefined) {
            throw new Error(`SubCircuit references unknown circuit: ${sub.circuitId}`);
        }
        const subObj = new SubCircuit(
            subVis.x || 0,
            subVis.y || 0,
            scope,
            String(scopeId)
        );
        if (sub.inputPorts && subObj.inputNodes) {
            for (
                let i = 0;
                i < sub.inputPorts.length && i < subObj.inputNodes.length;
                i++
            ) {
                portNodeMap[sub.inputPorts[i]] = subObj.inputNodes[i];
            }
        }
        if (sub.outputPorts && subObj.outputNodes) {
            for (
                let i = 0;
                i < sub.outputPorts.length && i < subObj.outputNodes.length;
                i++
            ) {
                portNodeMap[sub.outputPorts[i]] = subObj.outputNodes[i];
            }
        }
    }
    const intermediateNodeData = visual.intermediateNodes || [];
    const hasIntermediateConnectivity = intermediateNodeData.some(
        (n) => n.connections && n.connections.length > 0
    );

    // If bend/intermediate nodes were saved, recreate that exact route.
    if (hasIntermediateConnectivity) {
        const intermediateNodes = intermediateNodeData.map((ind) => {
            return new Node(
                ind.x,
                ind.y,
                2,
                scope.root,
                ind.bitWidth || 1,
                ind.label || ''
            );
        });
        const representedPorts = new Set();
        for (const intData of intermediateNodeData) {
            if (!intData.connections) continue;
            // Track which real ports are already connected via saved bends.
            for (const conn of intData.connections) {
                if (conn.type === 'port') {
                    representedPorts.add(conn.id);
                }
            }
        }
        for (let i = 0; i < intermediateNodeData.length; i++) {
            const intData = intermediateNodeData[i];
            if (!intData.connections) continue;
            for (const conn of intData.connections) {
                let targetNode = null;
                if (conn.type === 'port') {
                    targetNode = portNodeMap[conn.id];
                } else if (conn.type === 'intermediate') {
                    targetNode = intermediateNodes[conn.index];
                }
                if (
                    targetNode &&
                    !intermediateNodes[i].connections.includes(targetNode)
                ) {
                    intermediateNodes[i].connect(targetNode);
                }
            }
        }
        for (const net of circuit.netlist.nets) {
            // Only chain endpoints not already covered by intermediate-node links.
            const unrepresentedPorts = [];
            for (const portId of net.connections) {
                if (representedPorts.has(portId)) continue;
                const mappedNode = portNodeMap[portId];
                if (mappedNode !== undefined) unrepresentedPorts.push(mappedNode);
            }
            connectNodeChain(unrepresentedPorts);
        }
    } else {
        // No saved intermediate nodes, so rebuild plain net order wiring.
        for (const net of circuit.netlist.nets) {
            const nodes = [];
            for (const portId of net.connections) {
                const mappedNode = portNodeMap[portId];
                if (mappedNode !== undefined) nodes.push(mappedNode);
            }
            connectNodeChain(nodes);
        }
    }
    if (circuit.restrictedCircuitElementsUsed) {
        scope.restrictedCircuitElementsUsed =
            circuit.restrictedCircuitElementsUsed;
    }
    if (circuit.verilogMetadata) {
        scope.verilogMetadata = circuit.verilogMetadata;
    }
    if (circuit.testbenchData) {
        scope.testbenchData = new TestbenchData(
            circuit.testbenchData.testData,
            circuit.testbenchData.currentGroup,
            circuit.testbenchData.currentCase
        );
    }
    if (visual.layout) {
        scope.layout = {
            width: visual.layout.width || 100,
            height: visual.layout.height || 40,
            title_x: visual.layout.titleX || 50,
            title_y: visual.layout.titleY || 13,
            titleEnabled: visual.layout.titleEnabled !== false,
        };
    }
    if (scope.layout.titleEnabled === undefined) {
        scope.layout.titleEnabled = true;
    }
}

export function isCanonicalFormat(data) {
    return (
        data &&
        typeof data === 'object' &&
        data.formatVersion === '1.0' &&
        data.project &&
        Array.isArray(data.circuits)
    );
}

export default function loadCanonical(canonicalData) {
    if (typeof canonicalData === 'string') {
        // Import flow sometimes hands us raw JSON text.
        canonicalData = JSON.parse(canonicalData);
    }
    if (!isCanonicalFormat(canonicalData)) {
        throw new Error('Input is not canonical format v1.0');
    }
    const simulatorStore = SimulatorStore();
    const { circuit_list } = toRefs(simulatorStore);
    const isEmbedded = typeof embed !== 'undefined' && embed;
    setProjectName(
        canonicalData.project.name || canonicalData.project.projectId || 'Untitled'
    );
    globalScope = undefined;
    resetScopeList();

    // Prefer original scope ids when present so subcircuit refs stay stable.
    const circuitIdToScopeId = {};
    for (const circuit of canonicalData.circuits) {
        circuitIdToScopeId[circuit.id] =
            circuit.originalId !== undefined ? circuit.originalId : generateId();
    }
    for (const circuit of canonicalData.circuits) {
        const scopeId = circuitIdToScopeId[circuit.id];
        let isVerilogCircuit = false;
        let isMainCircuit = false;
        if (circuit.verilogMetadata) {
            isVerilogCircuit = circuit.verilogMetadata.isVerilogCircuit;
            isMainCircuit = circuit.verilogMetadata.isMainCircuit;
        }
        const scope = newCircuit(
            circuit.name || 'Untitled',
            scopeId,
            isVerilogCircuit,
            isMainCircuit
        );
        loadCanonicalCircuit(scope, circuit, circuitIdToScopeId);
        globalScope = scope;
        globalScope.centerFocus(isEmbedded);
        update(globalScope, true);
        updateRestrictedElementsInScope();
        scheduleBackup();
    }
    simulationArea.changeClockTime(canonicalData.project.timePeriod || 500);
    simulationArea.clockEnabled =
        canonicalData.project.clockEnabled !== false;
    if (!isEmbedded) {
        // In editor mode, refresh property panel after load.
        showProperties(simulationArea.lastSelected);
    }
    if (canonicalData.project.tabOrder) {
        const tabOrder = canonicalData.project.tabOrder.map(
            (id) => String(circuitIdToScopeId[id] || id)
        );
        const tabOrderIndex = new Map();
        for (let i = 0; i < tabOrder.length; i++) {
            tabOrderIndex.set(tabOrder[i], i);
        }
        circuit_list.value.sort((a, b) => {
            const aIndex = tabOrderIndex.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER;
            const bIndex = tabOrderIndex.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER;
            return aIndex - bIndex;
        });
    }
    if (canonicalData.project.focusedCircuitId) {
        const focusedScopeId =
            circuitIdToScopeId[canonicalData.project.focusedCircuitId];
        if (focusedScopeId) {
            switchCircuit(String(focusedScopeId));
        }
    } else if (canonicalData.circuits.length > 0) {
        // Match save behavior: last circuit in list is usually main.
        const lastCircuit =
            canonicalData.circuits[canonicalData.circuits.length - 1];
        const lastScopeId = circuitIdToScopeId[lastCircuit.id];
        if (lastScopeId) {
            switchCircuit(String(lastScopeId));
        }
    }
    updateSimulationSet(true);
    updateCanvasSet(true);
    gridUpdateSet(true);
    if (!isEmbedded) {
        plotArea.reset();
    }
    scheduleUpdate(1);
}
