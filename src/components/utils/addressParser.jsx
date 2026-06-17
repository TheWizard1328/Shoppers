import { abbreviateAddressDirections, normalizeStreetTypes } from './addressCleaner';

export function cleanAddressAndNotes(address, notes) {
    let cleanedAddress = (address || '').trim();
    let cleanedNotes = (notes || '').trim();
    let unitNumber = '';

    console.log('═══════════════════════════════════════');
    console.log('INPUT - Address:', cleanedAddress);
    console.log('INPUT - Notes:', cleanedNotes);

    // STEP 1: Extract unit from address (after #, before comma or end)
    let extractedUnit = '';
    const hashIndex = cleanedAddress.indexOf('#');
    
    if (hashIndex !== -1) {
        const afterHash = cleanedAddress.substring(hashIndex);
        const commaIndex = afterHash.indexOf(',');
        
        if (commaIndex !== -1) {
            extractedUnit = afterHash.substring(1, commaIndex).trim();
            cleanedAddress = cleanedAddress.substring(0, hashIndex).trim() + afterHash.substring(commaIndex);
        } else {
            extractedUnit = afterHash.substring(1).trim();
            cleanedAddress = cleanedAddress.substring(0, hashIndex).trim();
        }
        
        console.log('STEP 1 - Extracted unit from address:', extractedUnit);
        console.log('STEP 1 - Cleaned address:', cleanedAddress);
    }

    // STEP 2: Replace ' - ' with linefeeds
    cleanedNotes = cleanedNotes.replace(/ - /g, '\n');
    console.log('STEP 2 - Notes after dash replacement:', cleanedNotes);

    // STEP 2.3: Clean up specific return/disposal patterns
    // Replace 'DEAD MEDS RETURN For:' with 'DEAD MEDS RETURN' (handles both ' - ' already replaced with \n, and original ' For:')
    cleanedNotes = cleanedNotes.replace(/DEAD MEDS RETURN\s*[\n\-]*\s*For:/gi, 'DEAD MEDS RETURN');
    // Replace 'RETURN FOR DISPOSAL For:' with 'RETURN FOR DISPOSAL'
    cleanedNotes = cleanedNotes.replace(/RETURN FOR DISPOSAL\s*[\n\-]*\s*For:/gi, 'RETURN FOR DISPOSAL');
    console.log('STEP 2.3 - Notes after return/disposal cleanup:', cleanedNotes);

    // STEP 2.5: Remove lines containing "For:" if notes also contain "Patient Return" (case-insensitive)
    if (/patient\s+return/i.test(cleanedNotes) && /For:/i.test(cleanedNotes)) {
        const lines = cleanedNotes.split('\n');
        const filteredLines = lines.filter(line => !/For:/i.test(line));
        cleanedNotes = filteredLines.join('\n').trim();
        console.log('STEP 2.5 - Removed For: lines (Patient Return detected):', cleanedNotes);
    }

    // STEP 3 & 4: Find line with # and unit, extract it, remove from notes
    if (extractedUnit) {
        const lines = cleanedNotes.split('\n');
        let foundIndex = -1;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('#') && line.includes(extractedUnit)) {
                unitNumber = line.replace(/^#\s*/, '').trim();
                foundIndex = i;
                console.log('STEP 3 - Found unit line:', line);
                console.log('STEP 3 - Extracted unitNumber:', unitNumber);
                break;
            }
        }
        
        if (foundIndex !== -1) {
            lines.splice(foundIndex, 1);
            cleanedNotes = lines.join('\n').trim();
            console.log('STEP 4 - Removed line from notes');
        } else {
            unitNumber = extractedUnit;
            console.log('STEP 3 - No line found, using:', unitNumber);
        }
    }

    // Extract preferences - EXPLICITLY set all to false first, then set to true if found
    let preferences = {
        mailbox_ok: false,
        call_upon_arrival: false,
        ring_bell: false,
        dont_ring_bell: false,
        back_door: false
    };
    
    if (/\bmailbox\s+ok\b/i.test(cleanedNotes)) {
        preferences.mailbox_ok = true;
        cleanedNotes = cleanedNotes.replace(/\bmailbox\s+ok\b/gi, '').trim();
    }
    
    if (/\bcall\s+upon\s+arrival\b/i.test(cleanedNotes)) {
        preferences.call_upon_arrival = true;
        cleanedNotes = cleanedNotes.replace(/\bcall\s+upon\s+arrival\b/gi, '').trim();
    }
    
    if (/\bdon'?t\s+ring\s+bell\b/i.test(cleanedNotes)) {
        preferences.dont_ring_bell = true;
        cleanedNotes = cleanedNotes.replace(/\bdon'?t\s+ring\s+bell\b/gi, '').trim();
    } else if (/\bring\s+bell\b/i.test(cleanedNotes)) {
        preferences.ring_bell = true;
        cleanedNotes = cleanedNotes.replace(/\bring\s+bell\b/gi, '').trim();
    }
    
    if (/\bback\s+door\b/i.test(cleanedNotes)) {
        preferences.back_door = true;
        cleanedNotes = cleanedNotes.replace(/\bback\s+door\b/gi, '').trim();
    }

    // Extract recurring patterns - EXPLICITLY set all to false first
    let recurring = {
        recurring_daily: false,
        recurring_weekly_mon: false,
        recurring_weekly_tue: false,
        recurring_weekly_wed: false,
        recurring_weekly_thu: false,
        recurring_weekly_fri: false,
        recurring_weekly_sat: false,
        recurring_weekly_sun: false,
        recurring_biweekly: false,
        recurring_weekly_x4: false,
        recurring_bimonthly: false,
        recurring_monthly: false
    };
    
    if (/\bdaily\b/i.test(cleanedNotes)) {
        recurring.recurring_daily = true;
        cleanedNotes = cleanedNotes.replace(/\bdaily\b/gi, '').trim();
    }
    
    const biweeklyMatch = cleanedNotes.match(/\bbi[\s-]?weekly\s*\(([^)]+)\)/i);
    if (biweeklyMatch) {
        recurring.recurring_biweekly = true;
        const daysStr = biweeklyMatch[1].toLowerCase();
        
        if (/\b(mon|monday)\b/i.test(daysStr)) recurring.recurring_weekly_mon = true;
        if (/\b(tue|tues|tuesday)\b/i.test(daysStr)) recurring.recurring_weekly_tue = true;
        if (/\b(wed|wednesday)\b/i.test(daysStr)) recurring.recurring_weekly_wed = true;
        if (/\b(thu|thur|thurs|thursday)\b/i.test(daysStr)) recurring.recurring_weekly_thu = true;
        if (/\b(fri|friday)\b/i.test(daysStr)) recurring.recurring_weekly_fri = true;
        if (/\b(sat|saturday)\b/i.test(daysStr)) recurring.recurring_weekly_sat = true;
        if (/\b(sun|sunday)\b/i.test(daysStr)) recurring.recurring_weekly_sun = true;
        
        cleanedNotes = cleanedNotes.replace(/\bbi[\s-]?weekly\s*\([^)]+\)/gi, '').trim();
    } else if (/\bbi[\s-]?weekly\b/i.test(cleanedNotes)) {
        recurring.recurring_biweekly = true;
        cleanedNotes = cleanedNotes.replace(/\bbi[\s-]?weekly\b/gi, '').trim();
    }
    
    const weeklyMatch = cleanedNotes.match(/\bweekly\s*\(([^)]+)\)/i);
    if (weeklyMatch) {
        const daysStr = weeklyMatch[1].toLowerCase();
        
        if (/\b(mon|monday)\b/i.test(daysStr)) recurring.recurring_weekly_mon = true;
        if (/\b(tue|tues|tuesday)\b/i.test(daysStr)) recurring.recurring_weekly_tue = true;
        if (/\b(wed|wednesday)\b/i.test(daysStr)) recurring.recurring_weekly_wed = true;
        if (/\b(thu|thur|thurs|thursday)\b/i.test(daysStr)) recurring.recurring_weekly_thu = true;
        if (/\b(fri|friday)\b/i.test(daysStr)) recurring.recurring_weekly_fri = true;
        if (/\b(sat|saturday)\b/i.test(daysStr)) recurring.recurring_weekly_sat = true;
        if (/\b(sun|sunday)\b/i.test(daysStr)) recurring.recurring_weekly_sun = true;
        
        cleanedNotes = cleanedNotes.replace(/\bweekly\s*\([^)]+\)/gi, '').trim();
    }
    
    // Weekly x4 with day: "Weekly x4 (Fri)" or "Weekly x4(Friday)"
    const weeklyX4Match = cleanedNotes.match(/\bweekly\s+x\s*4\s*\(([^)]+)\)/i);
    if (weeklyX4Match) {
        recurring.recurring_weekly_x4 = true;
        const dayStr = weeklyX4Match[1].toLowerCase().trim();
        
        // Extract the day and set recurring_weekly_x4_day
        if (/\b(mon|monday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'mon';
            recurring.recurring_weekly_mon = true;
        } else if (/\b(tue|tues|tuesday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'tue';
            recurring.recurring_weekly_tue = true;
        } else if (/\b(wed|wednesday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'wed';
            recurring.recurring_weekly_wed = true;
        } else if (/\b(thu|thur|thurs|thursday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'thu';
            recurring.recurring_weekly_thu = true;
        } else if (/\b(fri|friday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'fri';
            recurring.recurring_weekly_fri = true;
        } else if (/\b(sat|saturday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'sat';
            recurring.recurring_weekly_sat = true;
        } else if (/\b(sun|sunday)\b/i.test(dayStr)) {
            recurring.recurring_weekly_x4_day = 'sun';
            recurring.recurring_weekly_sun = true;
        }
        
        cleanedNotes = cleanedNotes.replace(/\bweekly\s+x\s*4\s*\([^)]+\)/gi, '').trim();
    } else if (/\bweekly\s+x\s*4\b/i.test(cleanedNotes)) {
        // Weekly x4 without day specified
        recurring.recurring_weekly_x4 = true;
        cleanedNotes = cleanedNotes.replace(/\bweekly\s+x\s*4\b/gi, '').trim();
    }
    
    if (/\bbi[\s-]?monthly\b/i.test(cleanedNotes)) {
        recurring.recurring_bimonthly = true;
        cleanedNotes = cleanedNotes.replace(/\bbi[\s-]?monthly\b/gi, '').trim();
    }
    
    if (/\bmonthly\b/i.test(cleanedNotes)) {
        recurring.recurring_monthly = true;
        cleanedNotes = cleanedNotes.replace(/\bmonthly\b/gi, '').trim();
    }

    // Clean up extra whitespace
    cleanedNotes = cleanedNotes.replace(/\n\s*\n/g, '\n').trim();

    // Abbreviate compass directions in the final address (North→N, Northwest→NW, etc.)
    cleanedAddress = abbreviateAddressDirections(cleanedAddress);

    // Normalize street types (Street→St, Avenue→Ave, Road→Rd, Boulevard→Blvd, Crescent→Cres)
    cleanedAddress = normalizeStreetTypes(cleanedAddress);

    console.log('FINAL - unitNumber:', unitNumber);
    console.log('FINAL - cleanedAddress:', cleanedAddress);
    console.log('FINAL - cleanedNotes:', cleanedNotes);
    console.log('FINAL - preferences:', preferences);
    console.log('FINAL - recurring:', recurring);
    console.log('═══════════════════════════════════════');

    return {
        cleanedAddress,
        unitNumber,
        cleanedNotes,
        preferences,
        recurring
    };
}

export function parseAddress(address, notes) {
    return cleanAddressAndNotes(address, notes);
}