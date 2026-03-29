// export canonical json from current project
import { generateSaveData } from '../save'
import { CanonicalConverter } from './canonical_converter'

// generate canonical string
export async function generateCanonicalData(name) {
    // First generate the legacy save data
    const legacyDataStr = await generateSaveData(name, false)
    if (legacyDataStr instanceof Error) {
        throw legacyDataStr
    }
    if (typeof legacyDataStr !== 'string') {
        throw new Error('Legacy save did not return JSON string')
    }
    let legacyData
    try {
        legacyData = JSON.parse(legacyDataStr)
    } catch (err) {
        throw new Error('Could not parse legacy save JSON: ' + err.message)
    }
    //then convert that legacy to canonical and output
    const canonical = CanonicalConverter.toCanonical(legacyData)
    return JSON.stringify(canonical, null, 2)
}
