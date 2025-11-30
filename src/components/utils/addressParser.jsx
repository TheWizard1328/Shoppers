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
    
    if (/\bweekly\s+x\s*4\b/i.test(cleanedNotes)) {
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