/**
 * CircuitVerse Canonical Circuit Converter
 *
 * Converts legacy CircuitVerse JSON format to the new canonical structured format.
 * The canonical format is deterministic — two logically identical circuits will
 * always produce identical canonical output regardless of placement order, visual
 * layout, or serialization timing.
 *
 * Key Principles:
 * 1. Visual–Logic Separation: netlist (pure logic) vs visual (x,y,direction)
 * 2. Net-based connectivity: connections expressed as named nets, not index arrays
 * 3. Deterministic ordering: components/nets sorted by canonical IDs
 * 4. Idempotent: converting the same circuit always gives the same result
 *
 * @module CanonicalConverter
 */

// Annotation element types — these carry no logical information
const ANNOTATION_TYPES = new Set(['Text', 'Rectangle', 'Arrow', 'ImageAnnotation']);

/**
 * @class CanonicalConverter
 * Converter from legacy .cv format to canonical format.
 */
class CanonicalConverter {

    //  LEGACY → CANONICAL

    /**
     * Convert a legacy CircuitVerse JSON object to canonical format.
     *
     * @param {Object|string} legacyData - Legacy JSON (or JSON string)
     * @returns {Object} canonical
     */
    static toCanonical(legacyData) {
        // Accept object input or raw JSON string.
        if (typeof legacyData === 'string') {
            legacyData = JSON.parse(legacyData);
        }

        // Canonical project envelope.
        const canonical = {
            formatVersion: '1.0',
            generator: 'CircuitVerse Canonical Converter v1.0',
            generatedAt: new Date().toISOString(),
            project: this._convertProjectMetadata(legacyData),
            circuits: [],
        };

        // legacy scope id -> scope name (used by subcircuit resolution)
        const scopeNameMap = {};
        for (const scope of legacyData.scopes) {
            scopeNameMap[scope.id] = scope.name;
        }

        // Convert each scope into one canonical circuit.
        for (const scope of legacyData.scopes) {
            const circuit = this._convertScope(scope, scopeNameMap);
            canonical.circuits.push(circuit);
        }

        // Hash logic-only data for equivalence checks.
        canonical.canonicalHash = this._computeCanonicalHash(canonical); //debug

        return canonical;
    }

    /**
     * Extract project-level metadata from legacy data.
     */
    static _convertProjectMetadata(legacy) {
        // Name fallback chain.
        const meta = {
            name: legacy.name || legacy['name '] || 'Untitled',
        };

        // Copy optional project-level fields.
        if (legacy.projectId) meta.projectId = String(legacy.projectId);
        if (legacy.clockEnabled !== undefined) meta.clockEnabled = legacy.clockEnabled;
        if (legacy.timePeriod !== undefined) meta.timePeriod = legacy.timePeriod;
        if (legacy.focussedCircuit !== undefined) meta.focusedCircuitId = String(legacy.focussedCircuit);
        if (legacy.orderedTabs) meta.tabOrder = legacy.orderedTabs.map(String);
        return meta;
    }

    /** Convert a single legacy scope into a canonical circuit. */
    static _convertScope(scope, scopeNameMap) {
        // Canonical circuit shell.
        const circuit = {
            id: this._makeCircuitId(scope.name),
            // Preserve legacy scope id for import mapping.
            originalId: scope.id,
            name: scope.name,
            netlist: { components: [], nets: [], interfacePorts: { inputs: [], outputs: [] } },
        };

        // ---------- 1. allNodes ----------
        // Legacy wiring graph.
        const allNodes = scope.allNodes || [];

        // nodeIndex -> canonicalPortId
        const portMap = {};

        // ---------- 2. Collect and categorize elements ----------
        const elements = this._extractElements(scope);
        const annotations = [], subcircuits = [], logicElements = [];
        for (const elem of elements) {
            if (ANNOTATION_TYPES.has(elem.objectType)) annotations.push(elem);
            else if (elem.objectType === 'SubCircuit') subcircuits.push(elem);
            else logicElements.push(elem);
        }

        // ---------- 3. Build connectivity graph (single Union-Find, reused for WL + nets) ----------
        // Group connected node indices into nets using Union-Find.
        const uf = new UnionFind(allNodes.length);
        for (let i = 0; i < allNodes.length; i++) {
            const node = allNodes[i];
            if (node && node.connections) {
                for (const c of node.connections)
                    // Ignore invalid references.
                    if (c >= 0 && c < allNodes.length) uf.union(i, c);
            }
        }

        // rootIndex -> [nodeIndices]
        const netGroups = {};
        for (let i = 0; i < allNodes.length; i++) {
            const root = uf.find(i);
            (netGroups[root] || (netGroups[root] = [])).push(i);
        }

        // ---------- 4. Structural hashing & deterministic sort ----------
        // WL hashing + stable sort for deterministic ordering.
        this._computeStructuralHashes(logicElements, allNodes, netGroups, subcircuits, scopeNameMap);
        logicElements.sort((a, b) =>
            a.objectType.localeCompare(b.objectType) ||
            (a.label || '').localeCompare(b.label || '') ||
            (a._wlHash || '').localeCompare(b._wlHash || '') ||
            (a.x - b.x) || (a.y - b.y)
        );

        // ---------- 5. Assign canonical IDs ----------
        // Type-local IDs: AndGate_0, Input_0, etc.
        const typeCounters = {};
        for (const elem of logicElements) {
            const type = elem.objectType;
            typeCounters[type] = (typeCounters[type] || 0);
            const canonicalId = `${type}_${typeCounters[type]}`;
            elem._canonicalId = canonicalId;
            typeCounters[type]++;

            // Canonical component record.
            const component = {
                id: canonicalId,
                type: type,
                label: elem.label || '',
                properties: this._extractProperties(elem),
                ports: {},
            };

            // Copy runtime state if present.
            if (elem.customData && elem.customData.values &&
                Object.keys(elem.customData.values).length > 0) {
                component.state = { ...elem.customData.values };
            }

            // Map legacy node indices to canonical port IDs.
            if (elem.customData && elem.customData.nodes) {
                for (const [portName, nodeRef] of Object.entries(elem.customData.nodes)) {
                    if (Array.isArray(nodeRef)) {
                        // Bus/vector port.
                        component.ports[portName] = nodeRef.map((idx, i) => {
                            const portId = `${canonicalId}.${portName}.${i}`;
                            portMap[idx] = portId;
                            return portId;
                        });
                    } else {
                        // Scalar port.
                        const portId = `${canonicalId}.${portName}`;
                        portMap[nodeRef] = portId;
                        component.ports[portName] = portId;
                    }
                }
            }

            circuit.netlist.components.push(component);

            // Add interface metadata for Input/Output.
            if (type === 'Input') {
                const cp = (elem.customData && elem.customData.constructorParamaters) || [];
                const iface = {
                    componentId: canonicalId,
                    label: elem.label || '',
                    bitWidth: this._getBitWidth(elem),
                    order: circuit.netlist.interfacePorts.inputs.length,
                };
                if (cp[2] && typeof cp[2] === 'object' && Object.keys(cp[2]).length > 0) {
                    iface.layoutPosition = cp[2];
                }
                circuit.netlist.interfacePorts.inputs.push(iface);
            } else if (type === 'Output') {
                const cp = (elem.customData && elem.customData.constructorParamaters) || [];
                const iface = {
                    componentId: canonicalId,
                    label: elem.label || '',
                    bitWidth: this._getBitWidth(elem),
                    order: circuit.netlist.interfacePorts.outputs.length,
                };
                if (cp[2] && typeof cp[2] === 'object' && Object.keys(cp[2]).length > 0) {
                    iface.layoutPosition = cp[2];
                }
                circuit.netlist.interfacePorts.outputs.push(iface);
            }
        }

        // ---------- 3. Process SubCircuit instances ----------
        // Build subcircuit instance records.
        if (subcircuits.length > 0) {
            circuit.netlist.subcircuitInstances = [];

            // Stable ordering by referenced circuit name.
            subcircuits.sort((a, b) => {
                const nameA = scopeNameMap[a.id] || '';
                const nameB = scopeNameMap[b.id] || '';
                return nameA.localeCompare(nameB);
            });

            const subCounters = {};
            for (const sub of subcircuits) {
                const circuitRef = this._makeCircuitId(scopeNameMap[sub.id] || String(sub.id));
                subCounters[circuitRef] = (subCounters[circuitRef] || 0);
                const instanceId = `SubCircuit_${circuitRef}_${subCounters[circuitRef]}`;
                subCounters[circuitRef]++;

                // Convert legacy node indices to canonical sub-instance ports.
                const inputPorts = (sub.inputNodes || []).map((idx, i) => {
                    const portId = `${instanceId}.in.${i}`;
                    portMap[idx] = portId;
                    return portId;
                });

                const outputPorts = (sub.outputNodes || []).map((idx, i) => {
                    const portId = `${instanceId}.out.${i}`;
                    portMap[idx] = portId;
                    return portId;
                });

                circuit.netlist.subcircuitInstances.push({
                    id: instanceId,
                    circuitId: circuitRef,
                    inputPorts,
                    outputPorts,
                    version: sub.version || '1.0',
                });
            }
        }

        // ---------- 6. Build net objects from pre-computed netGroups ----------
        // Translate DSU groups to canonical nets.
        const nets = [];
        for (const [, nodeIndices] of Object.entries(netGroups)) {
            const connections = [];
            let bitWidth = 1, label = '';
            for (const idx of nodeIndices) {
                // Include mapped endpoints.
                if (portMap[idx]) connections.push(portMap[idx]);

                // Carry width/label hints from grouped nodes.
                if (allNodes[idx].bitWidth) bitWidth = allNodes[idx].bitWidth;
                if (allNodes[idx].label) label = allNodes[idx].label;
            }

            // Ignore dangling/single-ended groups.
            if (connections.length >= 2) {
                connections.sort();
                const net = { id: '', bitWidth, connections };
                if (label) net.label = label;
                nets.push(net);
            }
        }

        // Stable net ordering, then assign IDs.
        nets.sort((a, b) => a.connections.join(',').localeCompare(b.connections.join(',')));
        for (let i = 0; i < nets.length; i++) nets[i].id = `net_${i}`;

        circuit.netlist.nets = nets;

        // ---------- 7. Build visual metadata ----------
        const visual = this._buildVisualMetadata(scope, elements, annotations,
            subcircuits, allNodes, scopeNameMap, portMap);
        circuit.visual = visual;

        // Optional per-scope metadata pass-through.
        if (scope.testbenchData) circuit.testbenchData = scope.testbenchData;
        if (scope.verilogMetadata) circuit.verilogMetadata = scope.verilogMetadata;
        if (scope.restrictedCircuitElementsUsed && scope.restrictedCircuitElementsUsed.length > 0) {
            circuit.restrictedCircuitElementsUsed = scope.restrictedCircuitElementsUsed;
        }

        return circuit;
    }

    /** Extract all circuit elements from a scope (elements stored as scope[Type] = [...]). */
    static _extractElements(scope) {
        const elements = [];
        const skipKeys = new Set([
            'layout', 'verilogMetadata', 'allNodes', 'testbenchData',
            'id', 'name', 'nodes', 'restrictedCircuitElementsUsed'
        ]); // Keys that are not element arrays and should be skipped

        // Track per-type original indices.
        const typeIndices = {};

        // Flatten legacy per-type arrays into one element list.
        for (const [key, value] of Object.entries(scope)) {
            if (skipKeys.has(key)) continue;
            if (Array.isArray(value)) {
                for (let idx = 0; idx < value.length; idx++) {
                    const item = value[idx];
                    if (item && (item.objectType || key === 'SubCircuit')) {
                        const objType = item.objectType || key;
                        typeIndices[objType] = (typeIndices[objType] || 0);
                        elements.push({
                            ...item,
                            objectType: objType,
                            _originalTypeIndex: typeIndices[objType],
                        });
                        typeIndices[objType]++;
                    }
                }
            }
        }
        return elements;
    }

    /**
     * Weisfeiler-Leman structural hashing. Assigns `_wlHash` to each element
     * encoding type, properties, AND full connectivity topology — so two
     * elements with the same hash are structurally interchangeable.
     *
     * Receives pre-built netGroups (from the single Union-Find in _convertScope)
     * to avoid redundant graph traversal.
     */
    static _computeStructuralHashes(logicElements, allNodes, netGroups, subcircuits, scopeNameMap) {
        const N = logicElements.length;
        if (N === 0) return;

        // node index -> owning port descriptor
        const nodeToOwner = {};
        for (let ei = 0; ei < N; ei++) {
            const nodes = logicElements[ei].customData && logicElements[ei].customData.nodes;
            if (!nodes) continue;
            for (const [portName, ref] of Object.entries(nodes)) {
                if (Array.isArray(ref)) {
                    for (let i = 0; i < ref.length; i++)
                        nodeToOwner[ref[i]] = { ei, port: `${portName}.${i}` };
                } else {
                    nodeToOwner[ref] = { ei, port: portName };
                }
            }
        }
        for (let si = 0; si < subcircuits.length; si++) {
            const sub = subcircuits[si];
            (sub.inputNodes || []).forEach((idx, i) => {
                nodeToOwner[idx] = { si, port: `in.${i}`, isSub: true };
            });
            (sub.outputNodes || []).forEach((idx, i) => {
                nodeToOwner[idx] = { si, port: `out.${i}`, isSub: true };
            });
        }

        // Per-element, per-port adjacency from net groups.
        const portNets = logicElements.map(() => ({}));
        const subFp = subcircuits.map(s => `Sub:${scopeNameMap[s.id] || s.id}`);

        for (const nodeIndices of Object.values(netGroups)) {
            const owners = [];
            for (const idx of nodeIndices)
                if (nodeToOwner[idx]) owners.push(nodeToOwner[idx]);
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

        // Initial fingerprint from logic attributes only.
        let fp = logicElements.map(e => {
            let s = e.objectType;
            if (e.label) s += `|l=${e.label}`;
            const props = this._extractProperties(e);
            if (props) {
                const keys = Object.keys(props).filter(k => k !== '_rawConstructorParams').sort();
                if (keys.length) s += '|' + keys.map(k => `${k}:${JSON.stringify(props[k])}`).join(',');
            }
            return this._djb2(s);
        });

        // WL refinement until stable.
        for (let iter = 0; iter < N; iter++) {
            const next = new Array(N);
            let changed = false;
            for (let ei = 0; ei < N; ei++) {
                const descs = [];
                for (const [port, neighbors] of Object.entries(portNets[ei])) {
                    const nd = neighbors.map(n =>
                        n.isSub ? `${subFp[n.si]}:${n.port}` : `${fp[n.ei]}:${n.port}`
                    );
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

        // Persist final fingerprints for sorting.
        for (let ei = 0; ei < N; ei++) logicElements[ei]._wlHash = fp[ei];
    }

    /** Extract component properties from constructor parameters. */
    static _extractProperties(elem) {
        const props = {};

        // Legacy constructorParamaters array (legacy spelling).
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
                // Clock uses default constructor
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

    /**
     * Get bit width from element, checking constructor params.
     */
    static _getBitWidth(elem) {
        // Most legacy elements store bitWidth at constructorParamaters[1].
        const cp = (elem.customData && elem.customData.constructorParamaters) || [];
        return cp[1] || 1;
    }

    /**
     * Create a deterministic circuit ID from the name.
     */
    static _makeCircuitId(name) {
        // Slugify to deterministic circuit ID.
        return 'circuit_' + (name || 'unnamed')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
    }

    /** Build visual metadata from scope data. */
    static _buildVisualMetadata(scope, elements, annotations, subcircuits,
                                 allNodes, scopeNameMap, portMap) {
        // Visual-only metadata. Logic stays in netlist.
        const visual = {};

        // Layout (stays in visual — element positioning on canvas)
        if (scope.layout) {
            visual.layout = {
                width: scope.layout.width,
                height: scope.layout.height,
            };
            if (scope.layout.title_x !== undefined) visual.layout.titleX = scope.layout.title_x;
            if (scope.layout.title_y !== undefined) visual.layout.titleY = scope.layout.title_y;
            if (scope.layout.titleEnabled !== undefined) visual.layout.titleEnabled = scope.layout.titleEnabled;
        }

        // Component visuals keyed by canonical component ID.
        const logicElements = elements.filter(e =>
            !ANNOTATION_TYPES.has(e.objectType) && e.objectType !== 'SubCircuit'
        );

        visual.components = {};
        for (const elem of logicElements) {
            const canonicalId = elem._canonicalId;
            if (!canonicalId) continue;

            // Clean visual: only canvas position and orientation
            const vis = { x: elem.x, y: elem.y };
            if (elem.direction) vis.direction = elem.direction;
            if (elem.labelDirection) vis.labelDirection = elem.labelDirection;
            visual.components[canonicalId] = vis;
        }

        // Subcircuit visuals
        if (subcircuits.length > 0) {
            subcircuits.sort((a, b) => {
                const nameA = scopeNameMap[a.id] || '';
                const nameB = scopeNameMap[b.id] || '';
                return nameA.localeCompare(nameB);
            });
            const subCounters = {};
            visual.subcircuits = {};
            for (const sub of subcircuits) {
                const circuitRef = this._makeCircuitId(scopeNameMap[sub.id] || String(sub.id));
                subCounters[circuitRef] = (subCounters[circuitRef] || 0);
                const instanceId = `SubCircuit_${circuitRef}_${subCounters[circuitRef]}`;
                subCounters[circuitRef]++;

                // Clean visual: only canvas position
                visual.subcircuits[instanceId] = { x: sub.x, y: sub.y };
            }
        }

        // Intermediate nodes preserve wire routing geometry.
        const intermediateNodeIndices = scope.nodes || [];
        if (intermediateNodeIndices.length > 0) {
            const idxMap = {};
            for (let i = 0; i < intermediateNodeIndices.length; i++)
                idxMap[intermediateNodeIndices[i]] = i;

            // Normalize intermediate connections to tagged references.
            const mapConns = (node) => {
                if (!node || !node.connections || !node.connections.length) return undefined;
                return node.connections.map(ci => {
                    if (idxMap[ci] !== undefined) return { type: 'intermediate', index: idxMap[ci] };
                    if (portMap && portMap[ci]) return { type: 'port', id: portMap[ci] };
                    return { type: 'unknown', x: allNodes[ci] ? allNodes[ci].x : 0,
                             y: allNodes[ci] ? allNodes[ci].y : 0 };
                });
            };

            visual.intermediateNodes = intermediateNodeIndices.map(idx => {
                const node = allNodes[idx];
                const entry = { x: node ? node.x : 0, y: node ? node.y : 0 };
                const conns = mapConns(node);
                if (conns) entry.connections = conns;
                return entry;
            });
        }

        // Annotations
        if (annotations.length > 0) {
            visual.annotations = annotations.map(a => {
                const ann = { type: a.objectType, x: a.x, y: a.y };
                if (a.label) ann.label = a.label;
                if (a.customData && a.customData.constructorParamaters) {
                    ann.properties = { constructorParams: a.customData.constructorParamaters };
                }
                return ann;
            });
        }

        return visual;
    }

    /** Hash the netlist sections for canonical equivalence checking. */
    static _computeCanonicalHash(canonical) {
        // Hash logic-only projection; exclude runtime state.
        const netlists = canonical.circuits.map(c => ({
            name: c.name,
            components: c.netlist.components.map(({ state, ...rest }) => rest),
            nets: c.netlist.nets,
            interfacePorts: c.netlist.interfacePorts,
            subcircuitInstances: c.netlist.subcircuitInstances,
        }));
        return this._djb2(JSON.stringify(netlists));
    }

    /** djb2 hash → hex string. Used for structural fingerprints and canonical hash. */
    static _djb2(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++)
            h = ((h << 5) + h + str.charCodeAt(i)) & 0xFFFFFFFF;
        return 'h_' + (h >>> 0).toString(16).padStart(8, '0');
    }

}

// ═══════════════════════════════════════════════════════════════════════
//  Union-Find (Disjoint Set Union) for net extraction
// ═══════════════════════════════════════════════════════════════════════

class UnionFind {
    constructor(size) {
        // DSU parent/rank arrays.
        this.parent = Array.from({ length: size }, (_, i) => i);
        this.rank = new Array(size).fill(0);
    }

    find(x) {
        // Path compression.
        if (this.parent[x] !== x) {
            this.parent[x] = this.find(this.parent[x]); // path compression
        }
        return this.parent[x];
    }

    union(x, y) {
        // Union by rank.
        const rootX = this.find(x);
        const rootY = this.find(y);
        if (rootX === rootY) return;
        if (this.rank[rootX] < this.rank[rootY]) {
            this.parent[rootX] = rootY;
        } else if (this.rank[rootX] > this.rank[rootY]) {
            this.parent[rootY] = rootX;
        } else {
            this.parent[rootY] = rootX;
            this.rank[rootX]++;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Module exports (works in Node.js, browser, and ES modules / Vite)
// ═══════════════════════════════════════════════════════════════════════

// ES module exports (for Vite / modern bundlers)
export { CanonicalConverter, UnionFind };

// CommonJS exports (for Node.js)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CanonicalConverter, UnionFind };
}

// Browser global (for script tags)
if (typeof window !== 'undefined') {
    window.CanonicalConverter = CanonicalConverter;
}
