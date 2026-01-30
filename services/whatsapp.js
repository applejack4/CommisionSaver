const axios = require('axios');

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

/**
 * Normalize phone number for WhatsApp Cloud API
 * Removes +, spaces, and ensures proper format
 * @param {string} phoneNumber - Phone number in any format
 * @returns {string} Normalized phone number
 */
function normalizePhoneNumber(phoneNumber) {
  // Remove +, spaces, dashes, and parentheses
  return phoneNumber.replace(/[\s+\-()]/g, '');
}

/**
 * Send WhatsApp message via Cloud API
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} message - Message text to send
 * @returns {Promise<Object>} API response
 */
async function sendMessage(phoneNumber, message) {
  debugger;
  console.log(`[whatsapp.sendMessage] Called with phoneNumber: ${phoneNumber}, message length: ${message?.length || 0}`);
  
  // #region agent log
  try {
    if (typeof fetch !== 'undefined') {
      fetch('http://127.0.0.1:7242/ingest/2e5d7a8b-2c31-4c53-bec6-7fab2ceda2df',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:25',message:'sendMessage called',data:{phoneNumber:phoneNumber,messageLength:message?message.length:0,hasAccessToken:!!ACCESS_TOKEN,hasPhoneNumberId:!!PHONE_NUMBER_ID},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'})}).catch(()=>{});
    }
  } catch (fetchError) {
    // Ignore fetch errors
  }
  // #endregion
  
  if (!ACCESS_TOKEN) {
    console.error('[whatsapp.sendMessage] ACCESS_TOKEN is missing');
    // #region agent log
    try {
      if (typeof fetch !== 'undefined') {
        fetch('http://127.0.0.1:7242/ingest/2e5d7a8b-2c31-4c53-bec6-7fab2ceda2df',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:28',message:'ACCESS_TOKEN missing',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'})}).catch(()=>{});
      }
    } catch (fetchError) {
      // Ignore fetch errors
    }
    // #endregion
    throw new Error('ACCESS_TOKEN environment variable is not set');
  }

  if (!PHONE_NUMBER_ID) {
    console.error('[whatsapp.sendMessage] PHONE_NUMBER_ID is missing');
    // #region agent log
    try {
      if (typeof fetch !== 'undefined') {
        fetch('http://127.0.0.1:7242/ingest/2e5d7a8b-2c31-4c53-bec6-7fab2ceda2df',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:32',message:'PHONE_NUMBER_ID missing',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H'})}).catch(()=>{});
      }
    } catch (fetchError) {
      // Ignore fetch errors
    }
    // #endregion
    throw new Error('PHONE_NUMBER_ID environment variable is not set');
  }

  if (!phoneNumber) {
    throw new Error('Phone number is required');
  }

  if (!message) {
    throw new Error('Message is required');
  }

  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  console.log(`[whatsapp.sendMessage] Normalized phone: ${normalizedPhone} (from ${phoneNumber})`);

  const payload = {
    messaging_product: 'whatsapp',
    to: normalizedPhone,
    type: 'text',
    text: {
      body: message
    }
  };

  console.log(`[whatsapp.sendMessage] Sending to ${BASE_URL}`);
  console.log(`[whatsapp.sendMessage] Payload:`, JSON.stringify({ ...payload, text: { body: message.substring(0, 50) + '...' } }, null, 2));

  // #region agent log
  try {
    if (typeof fetch !== 'undefined') {
      fetch('http://127.0.0.1:7242/ingest/2e5d7a8b-2c31-4c53-bec6-7fab2ceda2df',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:54',message:'Sending WhatsApp API request',data:{baseUrl:BASE_URL,normalizedPhone:normalizedPhone,payloadKeys:Object.keys(payload)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
    }
  } catch (fetchError) {
    // Ignore fetch errors
  }
  // #endregion

  try {
    const response = await axios.post(BASE_URL, payload, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[whatsapp.sendMessage] Success! Response status: ${response.status}`);
    console.log(`[whatsapp.sendMessage] Response data:`, JSON.stringify(response.data, null, 2));

    // #region agent log
    try {
      if (typeof fetch !== 'undefined') {
        fetch('http://127.0.0.1:7242/ingest/2e5d7a8b-2c31-4c53-bec6-7fab2ceda2df',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:62',message:'WhatsApp API success',data:{status:response.status,responseData:response.data},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
      }
    } catch (fetchError) {
      // Ignore fetch errors
    }
    // #endregion

    return response.data;
  } catch (error) {
    // #region agent log
    try {
      if (typeof fetch !== 'undefined') {
        fetch('http://127.0.0.1:7242/ingest/2e5d7a8b-2c31-4c53-bec6-7fab2ceda2df',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:66',message:'WhatsApp API error',data:{hasResponse:!!error.response,status:error.response?error.response.status:null,errorData:error.response?error.response.data:null,errorMessage:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
      }
    } catch (fetchError) {
      // Ignore fetch errors
    }
    // #endregion
    
    // Log error details for debugging
    console.error(`[whatsapp.sendMessage] Error sending message to ${normalizedPhone}:`);
    if (error.response) {
      console.error('WhatsApp API Error Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
      throw new Error(`WhatsApp API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error('WhatsApp API Request Error (no response):', error.message);
      console.error('Request details:', {
        url: BASE_URL,
        hasAccessToken: !!ACCESS_TOKEN,
        hasPhoneNumberId: !!PHONE_NUMBER_ID
      });
      throw new Error(`WhatsApp API Request Error: ${error.message}`);
    } else {
      console.error('WhatsApp API Error (setup):', error.message);
      console.error('Error stack:', error.stack);
      throw error;
    }
  }
}

module.exports = {
  sendMessage
};
