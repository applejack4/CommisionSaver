/**
 * Parse customer booking request from WhatsApp message
 * Expected formats:
 * - "Route: City A to City B, Date: 2024-01-15, Time: 08:00, Seats: 2"
 * - "City A to City B, 2024-01-15, 08:00, 2 seats"
 * - "BOOK City A City B 2024-01-15 08:00 2"
 * 
 * @param {string} messageText - Raw message text
 * @returns {Object|null} Parsed booking request or null if invalid
 */
function parseBookingRequest(messageText) {
  const text = messageText.trim().toUpperCase();
  
  // Try structured format: "Route: X to Y, Date: ..., Time: ..., Seats: ..."
  const structuredMatch = text.match(/ROUTE:\s*([^,]+)\s*TO\s*([^,]+).*DATE:\s*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}).*TIME:\s*(\d{1,2}:\d{2}).*SEATS?:\s*(\d+)/i);
  if (structuredMatch) {
    return {
      source: structuredMatch[1].trim(),
      destination: structuredMatch[2].trim(),
      date: normalizeDate(structuredMatch[3]),
      time: normalizeTime(structuredMatch[4]),
      seats: parseInt(structuredMatch[5], 10)
    };
  }
  
  // Try comma-separated format: "City A to City B, 2024-01-15, 08:00, 2 seats"
  const commaMatch = text.match(/([^,]+)\s+TO\s+([^,]+),\s*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}),\s*(\d{1,2}:\d{2}),\s*(\d+)\s*SEATS?/i);
  if (commaMatch) {
    return {
      source: commaMatch[1].trim(),
      destination: commaMatch[2].trim(),
      date: normalizeDate(commaMatch[3]),
      time: normalizeTime(commaMatch[4]),
      seats: parseInt(commaMatch[5], 10)
    };
  }
  
  // Try space-separated format: "BOOK City A City B 2024-01-15 08:00 2"
  const spaceMatch = text.match(/BOOK\s+([^\s]+)\s+([^\s]+)\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})\s+(\d+)/i);
  if (spaceMatch) {
    return {
      source: spaceMatch[1].trim(),
      destination: spaceMatch[2].trim(),
      date: normalizeDate(spaceMatch[3]),
      time: normalizeTime(spaceMatch[4]),
      seats: parseInt(spaceMatch[5], 10)
    };
  }
  
  // Try simple format: "City A to City B on 2024-01-15 at 08:00 for 2 seats"
  const simpleMatch = text.match(/([^\s]+)\s+TO\s+([^\s]+)\s+ON\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+AT\s+(\d{1,2}:\d{2})\s+FOR\s+(\d+)\s*SEATS?/i);
  if (simpleMatch) {
    return {
      source: simpleMatch[1].trim(),
      destination: simpleMatch[2].trim(),
      date: normalizeDate(simpleMatch[3]),
      time: normalizeTime(simpleMatch[4]),
      seats: parseInt(simpleMatch[5], 10)
    };
  }
  
  return null;
}

/**
 * Normalize date to YYYY-MM-DD format
 * @param {string} dateStr - Date string in various formats
 * @returns {string} Normalized date or null
 */
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  
  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  
  // DD/MM/YYYY format
  const ddmmyyyy = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }
  
  // Try to parse as date
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  return null;
}

/**
 * Normalize time to HH:MM format
 * @param {string} timeStr - Time string
 * @returns {string} Normalized time or null
 */
function normalizeTime(timeStr) {
  if (!timeStr) return null;
  
  // Already in HH:MM format
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [hours, minutes] = timeStr.split(':');
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }
  
  return null;
}

/**
 * Generate help message for customer
 * @returns {string} Help message
 */
function getHelpMessage() {
  return `To book seats, send your request in one of these formats:

📋 Format 1:
Route: [Source] to [Destination], Date: YYYY-MM-DD, Time: HH:MM, Seats: [number]

📋 Format 2:
[Source] to [Destination], YYYY-MM-DD, HH:MM, [number] seats

Example:
Route: Mumbai to Pune, Date: 2024-01-15, Time: 08:00, Seats: 2`;
}

module.exports = {
  parseBookingRequest,
  getHelpMessage
};
