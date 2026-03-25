/**
 * Export Canonical Circuit Data
 *
 * Generates canonical JSON from the current simulator state.
 * Uses the CanonicalConverter from the structured_format module
 * to convert the live circuit data into the canonical format.
 * @module exportCanonical
 */

import { generateSaveData } from '../save'

// Import the converter (works in browser via window global or direct import)
import { CanonicalConverter } from './canonical_converter'

/**
 * Generate canonical JSON string from the current project state.
 *
 * Flow: Live simulator → generateSaveData() → legacy JSON → CanonicalConverter.toCanonical()
 *
 * @param {string} name - Project name
 * @returns {Promise<string>} Canonical JSON string
 */
export async function generateCanonicalData(name) {
    // First generate the legacy save data (this is the standard serialization path)
    const legacyDataStr = await generateSaveData(name, false)

    if (legacyDataStr instanceof Error) {
        throw legacyDataStr
    }

    const legacyData = JSON.parse(legacyDataStr)

    // Convert to canonical format
    const canonical = CanonicalConverter.toCanonical(legacyData)

    // Return formatted JSON
    return JSON.stringify(canonical, null, 2)
}
