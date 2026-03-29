// legacy .cv -> canonical format
// These don't affect circuit logic, skip them
const ANNOTATION_TYPES = new Set(['Text', 'Rectangle', 'Arrow', 'ImageAnnotation']);

class CanonicalConverter {
    // convert whole project to canonical format
    static toCanonical(legacyData) {
        // allow string input too
        if (typeof legacyData === 'string') {
            try {
                legacyData = JSON.parse(legacyData);
            } catch (e) {
                throw new Error('Invalid JSON input: ' + e.message);
            }
        }
        if (!legacyData || !Array.isArray(legacyData.scopes)) {
            throw new Error('Malformed legacy project data: scopes missing');
        }
        const now = new Date().toISOString();
        const canonical = {
            formatVersion: '1.0',
            generator: 'CircuitVerse Canonical Converter v1.0',
            generatedAt: now,
            project: this._convertProjectMetadata(legacyData),
            circuits: [],
        };
        const scopeNameMap = {};
        const scopeList = legacyData.scopes;
        for (let i = 0; i < scopeList.length; i++) {
            const s = scopeList[i];
            scopeNameMap[s.id] = s.name;
        }
        // build circuits from each scope
        for (const scope of scopeList) {
            const circuit = this._convertScope(scope, scopeNameMap);
            if (circuit) {
                canonical.circuits.push(circuit);
            }
        }
        const hash = this._computeCanonicalHash(canonical);
        canonical.canonicalHash = hash;
        return canonical;
    }
    static _convertProjectMetadata(legacy) {
        let projectName = legacy.name;
        if (!projectName) {
            projectName = legacy['name '];  // Some files have space in key
        }
        if (!projectName) {
            projectName = 'Untitled';
        }
        const meta = { name: projectName };
        if (legacy.projectId !== undefined) {
            meta.projectId = String(legacy.projectId);
        }
        if (legacy.clockEnabled !== undefined) {
            meta.clockEnabled = legacy.clockEnabled;
        }
        if (legacy.timePeriod !== undefined) {
            meta.timePeriod = legacy.timePeriod;
        }
        // old misspelling kept for backward compatibility
        if (legacy.focussedCircuit !== undefined) {
            meta.focusedCircuitId = String(legacy.focussedCircuit);
        }
        if (legacy.orderedTabs && Array.isArray(legacy.orderedTabs)) {
            meta.tabOrder = legacy.orderedTabs.map(id => String(id));
        }
        return meta;
    }
    // convert one scope to canonical circuit record
    static _convertScope(scope, scopeNameMap) {
        const circuit = {
            id: this._makeCircuitId(scope.name),
            originalId: scope.id,
            name: scope.name,
            netlist: { components: [], nets: [], interfacePorts: { inputs: [], outputs: [] } },
        };
        const allNodes = Array.isArray(scope.allNodes) ? scope.allNodes : [];
        const portMap = {};
        const elements = this._extractElements(scope);
        //categorize into logical elements, subcircuits, and annotations
        const categorized = this._categorizeElements(elements);
        const annotations = categorized.annotations;
        const subcircuits = categorized.subcircuits;
        const logicElements = categorized.logicElements;
        // use union-find to group connected nodes into nets
        const uf = new UnionFind(allNodes.length);
        for (let i = 0; i < allNodes.length; i++) {
            const node = allNodes[i];
            if (node && Array.isArray(node.connections)) {
                for (const c of node.connections) {
                    // Ignore invalid references.
                    if (c >= 0 && c < allNodes.length) uf.union(i, c);
                }
            }
        }
        // collect grouped nodes
        const netGroups = {};
        for (let i = 0; i < allNodes.length; i++) {
            const root = uf.find(i);
            if (!netGroups[root]) netGroups[root] = [];
            netGroups[root].push(i);
        }
        // apply structural hashing - fingerprint each element by its connections
        this._computeStructuralHashes(logicElements, allNodes, netGroups, subcircuits, scopeNameMap);
        // sort elements deterministically for canonical ordering
        logicElements.sort((a, b) => {
            const typeCompare = a.objectType.localeCompare(b.objectType);
            if (typeCompare !== 0) return typeCompare;
            const labelCompare = (a.label || '').localeCompare(b.label || '');
            if (labelCompare !== 0) return labelCompare;
            const hashCompare = (a._wlHash || '').localeCompare(b._wlHash || '');
            if (hashCompare !== 0) return hashCompare;
            if (a.x !== b.x) return a.x - b.x;
            return a.y - b.y;
        });
        // assign canonical IDs and build component records
        const typeCounters = {};
        for (const elem of logicElements) {
            const type = elem.objectType;
            typeCounters[type] = (typeCounters[type] || 0);
            const canonicalId = `${type}_${typeCounters[type]}`;
            elem._canonicalId = canonicalId;
            typeCounters[type]++;
            const component = {
                id: canonicalId,
                type: type,
                label: elem.label || '',
                properties: this._extractProperties(elem),
                ports: {},
            };
            // preserve runtime state if it exists
            if (elem.customData && elem.customData.values &&
                Object.keys(elem.customData.values).length > 0) {
                component.state = { ...elem.customData.values };
            }
            // map ports to nodes - this is where connections get tracked
            if (elem.customData && elem.customData.nodes) {
                this._mapComponentPorts(elem.customData.nodes, canonicalId, component, portMap);
            }
            circuit.netlist.components.push(component);
            // register inputs and outputs as circuit interface ports
            if (type === 'Input' || type === 'Output') {
                this._registerInterfacePort(type, elem, canonicalId, circuit);
            }
        }
        // handle subcircuit instances
        if (subcircuits.length > 0) {
            circuit.netlist.subcircuitInstances = [];
            subcircuits.sort((a, b) => {
                const nameA = scopeNameMap[a.id] || '';
                const nameB = scopeNameMap[b.id] || '';
                return nameA.localeCompare(nameB);
            });
            this._buildSubcircuitInstances(subcircuits, scopeNameMap, circuit, portMap);
        }
        // build nets from node connectivity
        const nets = [];
        const netRoots = Object.keys(netGroups);
        for (const root of netRoots) {
            const nodeIndices = netGroups[root] || [];
            const connections = [];
            let bitWidth = 1;
            let label = '';
            // find properties from connected nodes
            for (const idx of nodeIndices) {
                if (portMap[idx]) {
                    connections.push(portMap[idx]);
                }
                // grab bitwidth/label from any node
                if (allNodes[idx]) {
                    if (allNodes[idx].bitWidth) bitWidth = allNodes[idx].bitWidth;
                    if (allNodes[idx].label) label = allNodes[idx].label;
                }
            }
            if (connections.length >= 2) {
                connections.sort();
                const net = { id: '', bitWidth, connections };
                if (label) net.label = label;
                nets.push(net);
            }
        }
        nets.sort((a, b) => a.connections.join(',').localeCompare(b.connections.join(',')));
        for (let i = 0; i < nets.length; i++) nets[i].id = `net_${i}`;
        circuit.netlist.nets = nets;
        const visual = this._buildVisualMetadata(scope, elements, annotations,
            subcircuits, allNodes, scopeNameMap, portMap);
        circuit.visual = visual;
        if (scope.testbenchData) circuit.testbenchData = scope.testbenchData;
        if (scope.verilogMetadata) circuit.verilogMetadata = scope.verilogMetadata;
        if (scope.restrictedCircuitElementsUsed && scope.restrictedCircuitElementsUsed.length > 0) {
            circuit.restrictedCircuitElementsUsed = scope.restrictedCircuitElementsUsed;
        }
        return circuit;
    }
    // pull all elements from legacy per-type arrays into one list
    static _extractElements(scope) {
        const elements = [];
        const skipKeys = new Set([
            'layout', 'verilogMetadata', 'allNodes', 'testbenchData',
            'id', 'name', 'nodes', 'restrictedCircuitElementsUsed'
        ]);
        const typeIndices = {};
        try {
            for (const [key, value] of Object.entries(scope)) {
                if (skipKeys.has(key)) {
                    continue;
                }
                if (!Array.isArray(value)) {
                    continue;
                }
                // iterate through each element in the array
                for (let idx = 0; idx < value.length; idx++) {
                    const item = value[idx];
                    if (!item) {
                        continue;
                    }
                    // infer type from objectType or use array key
                    const objType = item.objectType || key;
                    if (!objType || (key !== 'SubCircuit' && !item.objectType)) {
                        continue;
                    }
                    if (!typeIndices[objType]) {
                        typeIndices[objType] = 0;
                    }
                    // spread the item to preserve all properties
                    const element = {
                        ...item,
                        objectType: objType,
                        _originalTypeIndex: typeIndices[objType]
                    };
                    elements.push(element);
                    typeIndices[objType]++;
                }
            }
        } catch (e) {
            //if something went wrong, log and continue
            console.warn('Error extracting elements:', e);
        }
        return elements;
    }
    // extract and map component ports to node indices
    static _mapComponentPorts(nodes, canonicalId, component, portMap) {
        for (const [portName, nodeRef] of Object.entries(nodes)) {
            if (Array.isArray(nodeRef)) {
                const mapped = [];
                for (let i = 0; i < nodeRef.length; i++) {
                    const idx = nodeRef[i];
                    const portId = `${canonicalId}.${portName}.${i}`;
                    portMap[idx] = portId;
                    mapped.push(portId);
                }
                component.ports[portName] = mapped;
            } else {
                const portId = `${canonicalId}.${portName}`;
                portMap[nodeRef] = portId;
                component.ports[portName] = portId;
            }
        }
    }
    // register Input/Output ports as circuit interface
    static _registerInterfacePort(type, elem, canonicalId, circuit) {
        const cp = (elem.customData && elem.customData.constructorParamaters) || [];
        const iface = {
            componentId: canonicalId,
            label: elem.label || '',
            bitWidth: this._getBitWidth(elem),
            order: (type === 'Input' ? circuit.netlist.interfacePorts.inputs : circuit.netlist.interfacePorts.outputs).length,
        };
        if (type === 'Input') {
            circuit.netlist.interfacePorts.inputs.push(iface);
        } else {
            circuit.netlist.interfacePorts.outputs.push(iface);
        }
    }
    // categorize elements into annotations, subcircuits, and logic elements
    static _categorizeElements(elements) {
        const annotations = [];
        const subcircuits = [];
        const logicElements = [];
        for (const elem of elements) {
            if (ANNOTATION_TYPES.has(elem.objectType)) {
                annotations.push(elem);
            } else if (elem.objectType === 'SubCircuit') {
                subcircuits.push(elem);
            } else {
                logicElements.push(elem);
            }
        }
        return { annotations, subcircuits, logicElements };
    }
    // build subcircuit instances with port mappings
    static _buildSubcircuitInstances(subcircuits, scopeNameMap, circuit, portMap) {
        const subCounters = {};
        for (const sub of subcircuits) {
            const circuitRef = this._makeCircuitId(scopeNameMap[sub.id] || String(sub.id));
            subCounters[circuitRef] = (subCounters[circuitRef] || 0);
            const instanceId = `SubCircuit_${circuitRef}_${subCounters[circuitRef]}`;
            subCounters[circuitRef]++;
            // map input ports
            const inputPorts = [];
            const rawInputs = sub.inputNodes || [];
            for (let i = 0; i < rawInputs.length; i++) {
                const idx = rawInputs[i];
                const portId = `${instanceId}.in.${i}`;
                portMap[idx] = portId;
                inputPorts.push(portId);
            }
            // map output ports
            const outputPorts = [];
            const rawOutputs = sub.outputNodes || [];
            for (let i = 0; i < rawOutputs.length; i++) {
                const idx = rawOutputs[i];
                const portId = `${instanceId}.out.${i}`;
                portMap[idx] = portId;
                outputPorts.push(portId);
            }
            circuit.netlist.subcircuitInstances.push({
                id: instanceId,
                circuitId: circuitRef,
                inputPorts,
                outputPorts,
                version: sub.version || '1.0',
            });
        }
    }
    // compute structural fingerprint for each logic element
    // uses weisfeiler-lehman style refinement
    static _computeStructuralHashes(logicElements, allNodes, netGroups, subcircuits, scopeNameMap) {
        const N = logicElements.length;
        if (N === 0) return;
        const nodeCount = Array.isArray(allNodes) ? allNodes.length : 0;
        const isValidNode = (idx) => Number.isInteger(idx) && idx >= 0 && idx < nodeCount;
        // build owner map from nodes to components
        const nodeToOwner = {};
        for (let ei = 0; ei < N; ei++) {
            const nodes = logicElements[ei].customData && logicElements[ei].customData.nodes;
            if (!nodes) continue;
            for (const [portName, ref] of Object.entries(nodes)) {
                if (Array.isArray(ref)) {
                    for (let i = 0; i < ref.length; i++) {
                        const idx = ref[i];
                        if (isValidNode(idx)) {
                            nodeToOwner[idx] = { ei, port: `${portName}.${i}` };
                        }
                    }
                } else {
                    if (isValidNode(ref)) {
                        nodeToOwner[ref] = { ei, port: portName };
                    }
                }
            }
        }
        // also map subcircuit ports
        for (let si = 0; si < subcircuits.length; si++) {
            const sub = subcircuits[si];
            const inNodes = sub.inputNodes || [];
            for (let i = 0; i < inNodes.length; i++) {
                const idx = inNodes[i];
                if (isValidNode(idx)) {
                    nodeToOwner[idx] = { si, port: `in.${i}`, isSub: true };
                }
            }
            const outNodes = sub.outputNodes || [];
            for (let i = 0; i < outNodes.length; i++) {
                const idx = outNodes[i];
                if (isValidNode(idx)) {
                    nodeToOwner[idx] = { si, port: `out.${i}`, isSub: true };
                }
            }
        }
        // start with empty port connection maps
        const portNets = [];
        for (let i = 0; i < logicElements.length; i++) {
            portNets.push({});
        }
        // build subcircuit fingerprints
        const subFp = [];
        for (let i = 0; i < subcircuits.length; i++) {
            const s = subcircuits[i];
            subFp.push(`Sub:${scopeNameMap[s.id] || s.id}`);
        }
        // connect elements through nets
        for (const grpKey of Object.keys(netGroups)) {
            const nodeIndices = netGroups[grpKey] || [];
            const owners = [];
            for (const idx of nodeIndices) {
                if (isValidNode(idx) && nodeToOwner[idx]) {
                    owners.push(nodeToOwner[idx]);
                }
            }
            if (owners.length < 2) continue;
            for (const o of owners) {
                if (o.isSub) continue;
                const pn = portNets[o.ei];
                if (!pn[o.port]) pn[o.port] = [];
                for (const other of owners) {
                    if (other === o) continue;
                    pn[o.port].push(other);
                }
            }
        }
        let fp = [];
        for (let i = 0; i < logicElements.length; i++) {
            const e = logicElements[i];
            let s = e.objectType;
            if (e.label) s += `|l=${e.label}`;
            const props = this._extractProperties(e);
            if (props) {
                const keys = Object.keys(props)
                    .filter(k => k !== '_rawConstructorParams')
                    .sort();
                if (keys.length) {
                    const propParts = [];
                    for (const k of keys) {
                        propParts.push(`${k}:${JSON.stringify(props[k])}`);
                    }
                    s += '|' + propParts.join(',');
                }
            }
            fp.push(this._djb2(s));
        }
        // apply weisfeiler-lehman refinement
        for (let iter = 0; iter < N; iter++) {
            const next = new Array(N);
            let changed = false;
            for (let ei = 0; ei < N; ei++) {
                const descs = [];
                for (const [port, neighbors] of Object.entries(portNets[ei])) {
                    // describe neighbors for this port
                    const nd = neighbors.map(n => {
                        if (n.isSub) {
                            return `${subFp[n.si]}:${n.port}`;
                        } else {
                            return `${fp[n.ei]}:${n.port}`;
                        }
                    });
                    nd.sort();
                    descs.push(`${port}=[${nd}]`);
                }
                descs.sort();
                next[ei] = this._djb2(fp[ei] + '||' + descs.join(';;'));
                if (next[ei] !== fp[ei]) changed = true;
            }
            fp = next;
            if (!changed) break;
        }
        // assign computed hashes to each element
        for (let ei = 0; ei < N; ei++) {
            logicElements[ei]._wlHash = fp[ei];
        }
    }
    // Extract component properties from constructor parameters.
    // this is a big switch statement
    static _extractProperties(elem) {
        const props = {};
        const cp = (elem.customData && elem.customData.constructorParamaters) || [];
        // Common property: propagation delay
        if (elem.propagationDelay !== undefined && elem.propagationDelay !== 0) {
            props.propagationDelay = elem.propagationDelay;
        }
        // Map position-based constructor params to named properties.
        switch (elem.objectType) {
            case 'Input':
            case 'Output':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            case 'AndGate':
            case 'OrGate':
            case 'NandGate':
            case 'NorGate':
            case 'XorGate':
            case 'XnorGate':
                if (cp[1] !== undefined) props.inputSize = cp[1];
                if (cp[2] !== undefined) props.bitWidth = cp[2];
                break;
            case 'NotGate':
            case 'Buffer':
            case 'TriState':
            case 'ControlledInverter':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            case 'Multiplexer':
            case 'Demultiplexer':
            case 'Decoder':
            case 'PriorityEncoder':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                if (cp[2] !== undefined) props.controlSignalSize = cp[2];
                break;
            case 'DflipFlop':
            case 'TflipFlop':
            case 'JKflipFlop':
            case 'SRflipFlop':
            case 'Dlatch':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            case 'RAM':
            case 'EEPROM':
            case 'Rom':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                if (cp[2] !== undefined) props.addressWidth = cp[2];
                break;
            case 'Splitter':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                if (cp[2] !== undefined) props.bitWidthSplit = cp[2];
                break;
            case 'Clock':
                // Clock uses default constructor, so no special properties
                break;
            case 'Adder':
            case 'ALU':
            case 'TwoComplement':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            case 'ConstantVal':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                if (cp[2] !== undefined) props.value = cp[2];
                break;
            case 'Stepper':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            case 'Tunnel':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                if (cp[2] !== undefined) props.identifier = cp[2];
                break;
            case 'Flag':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            case 'BitSelector':
            case 'MSB':
            case 'LSB':
                if (cp[1] !== undefined) props.bitWidth = cp[1];
                break;
            default:
                // For unknown types, preserve constructor params
                if (cp.length > 0) {
                    props.constructorParams = cp;
                }
                break;
        }
        return Object.keys(props).length > 0 ? props : undefined;
    }
    // Get bit width from element, checking constructor params.
    // legacy elements store bitWidth at cp[1] but defaults to 1
    static _getBitWidth(elem) {
        const cp = (elem.customData && elem.customData.constructorParamaters) || [];
        const bw = cp[1];
        return (bw !== undefined && bw > 0) ? bw : 1;
    }
    // Create a deterministic circuit ID from the name.
    // converts spaces/special chars to underscores
    static _makeCircuitId(name) {
        const cleaned = (name || 'unnamed')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
        return 'circuit_' + cleaned;
    }
    // Build visual metadata from scope data.
    static _buildVisualMetadata(scope, elements, annotations, subcircuits,
                                 allNodes, scopeNameMap, portMap) {
        const visual = {};
        // Parse the layout info if it exists
        if (scope && scope.layout) {
            const layoutInfo = scope.layout;
            visual.layout = {
                width: layoutInfo.width || 800,
                height: layoutInfo.height || 600,
            };
            // Optional title position, havent tested it properly
            if (layoutInfo.title_x !== undefined) {
                visual.layout.titleX = layoutInfo.title_x;
            }
            if (layoutInfo.title_y !== undefined) {
                visual.layout.titleY = layoutInfo.title_y;
            }
            if (layoutInfo.titleEnabled !== undefined) {
                visual.layout.titleEnabled = layoutInfo.titleEnabled;
            }
        }
        // Component visuals - separate logic elements from subcircuits
        const logicElems = elements.filter(e => {
            if (ANNOTATION_TYPES.has(e.objectType)) return false;
            if (e.objectType === 'SubCircuit') return false;
            return true;
        });
        // Build visuals for each logic component
        visual.components = {};
        for (const elem of logicElems) {
            const cid = elem._canonicalId;
            if (!cid) continue;  // skip if no canonical ID
            const vis = {
                x: elem.x || 0,
                y: elem.y || 0
            };
            // only add direction if present
            if (elem.direction) {
                vis.direction = elem.direction;
            }
            if (elem.labelDirection !== undefined) {
                vis.labelDirection = elem.labelDirection;
            }
            visual.components[cid] = vis;
        }
        // Process subcircuit visuals - if they exist
        if (subcircuits && subcircuits.length > 0) {
            const subs = [...subcircuits].sort((a, b) => {
                const nameA = scopeNameMap[a.id] || '';
                const nameB = scopeNameMap[b.id] || '';
                return nameA.localeCompare(nameB);
            });
            const cnt = {};
            visual.subcircuits = {};
            for (const sub of subs) {
                const ref = this._makeCircuitId(scopeNameMap[sub.id] || String(sub.id));
                if (!cnt[ref]) cnt[ref] = 0;
                const iid = `SubCircuit_${ref}_${cnt[ref]}`;
                cnt[ref]++;
                visual.subcircuits[iid] = {
                    x: sub.x || 0,
                    y: sub.y || 0
                };
            }
        }
        // Intermediate nodes
        const intermediateNodeIndices = scope && scope.nodes ? scope.nodes : [];
        if (intermediateNodeIndices && intermediateNodeIndices.length > 0) {
            const idxMap = {};
            // Build index map
            for (let i = 0; i < intermediateNodeIndices.length; i++) {
                idxMap[intermediateNodeIndices[i]] = i;
            }
            // Helper to map node connections
            const mapConns = (node) => {
                // Check if node is valid
                if (!node) return undefined;
                if (!node.connections) return undefined;
                if (!Array.isArray(node.connections) || node.connections.length === 0) {
                    return undefined;
                }
                // Map each connection
                return node.connections.map(ci => {
                    // Check what type of connection this is
                    if (idxMap[ci] !== undefined) {
                        return { type: 'intermediate', index: idxMap[ci] };
                    }
                    if (portMap && portMap[ci]) {
                        return { type: 'port', id: portMap[ci] };
                    }
                    // Unknown connection - use position info
                    const unknownNode = allNodes && allNodes[ci];
                    return {
                        type: 'unknown',
                        x: unknownNode ? unknownNode.x : 0,
                        y: unknownNode ? unknownNode.y : 0
                    };
                });
            };
            // Build visual entry for each intermediate node
            visual.intermediateNodes = intermediateNodeIndices.map(idx => {
                const node = allNodes && allNodes[idx];
                const entry = {
                    x: node ? node.x : 0,
                    y: node ? node.y : 0
                };
                // Add connections if they exist
                const conns = mapConns(node);
                if (conns) {
                    entry.connections = conns;
                }
                return entry;
            });
        }
        //add annotations if they exist
        if (annotations && annotations.length > 0) {
            visual.annotations = [];
            for (const a of annotations) {
                const ann = {
                    type: a.objectType,
                    x: a.x || 0,
                    y: a.y || 0
                };
                if (a.label) {
                    ann.label = a.label;
                }
                // skip detailed properties for now
                visual.annotations.push(ann);
            }
        }
        return visual;
    }
    // Hash the netlist sections for canonical equivalence checking.
    //this is buggy rn, giving different hashes for the same structure.
    static _computeCanonicalHash(canonical) {
        const netlists = [];
        const circuits = canonical.circuits || [];
        for (const c of circuits) {
            const cleanComponents = [];
            const rawComponents = (c.netlist && c.netlist.components) || [];
            for (const comp of rawComponents) {
                // filter out runtime state, this only care about structure
                const clean = {};
                for (const [k, v] of Object.entries(comp)) {
                    if (k === 'state') continue;
                    clean[k] = v;
                }
                cleanComponents.push(clean);
            }
            // build canonical representation of this circuit
            const nl = {
                name: c.name,
                components: cleanComponents,
                nets: c.netlist ? c.netlist.nets : [],
                interfacePorts: c.netlist ? c.netlist.interfacePorts : { inputs: [], outputs: [] },
            };
            //should probably include subcircuitInstances but keeping it minimal for now
            if (c.netlist && c.netlist.subcircuitInstances) {
                nl.subcircuitInstances = c.netlist.subcircuitInstances;
            }
            netlists.push(nl);
        }
        return this._djb2(JSON.stringify(netlists));
    }
    // djb2 hash to hex string
    static _djb2(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h + str.charCodeAt(i)) & 0xFFFFFFFF;
        }
        return 'h_' + (h >>> 0).toString(16).padStart(8, '0');
    }
}

// Union-Find helper class for grouping connected nodes into nets
class UnionFind {
    constructor(size) {
        this.parent = Array.from({ length: size }, (_, i) => i);
        this.rank = new Array(size).fill(0);
    }
    find(x) {
        // path compression
        if (this.parent[x] !== x) {
            this.parent[x] = this.find(this.parent[x]);
        }
        return this.parent[x];
    }
    union(x, y) {
        const rx = this.find(x);
        const ry = this.find(y);
        if (rx === ry) return;
        // simple union - could use rank optimization but this is fine
        if (this.rank[rx] < this.rank[ry]) {
            this.parent[rx] = ry;
        } else if (this.rank[rx] > this.rank[ry]) {
            this.parent[ry] = rx;
        } else {
            this.parent[ry] = rx;
            this.rank[rx]++;
        }
    }
}

// Export for use in Vite, Node.js, and browsers
export { CanonicalConverter, UnionFind };
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CanonicalConverter, UnionFind };
}
// Browser global (for script tags)
if (typeof window !== 'undefined') {
    window.CanonicalConverter = CanonicalConverter;
}
