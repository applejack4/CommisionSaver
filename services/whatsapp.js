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
  console.log(`[whatsapp.sendMessage] Called with phoneNumber: ${phoneNumber}, message length: ${message?.length || 0}`);
  
  
  if (!ACCESS_TOKEN) {
    console.error('[whatsapp.sendMessage] ACCESS_TOKEN is missing');
    throw new Error('ACCESS_TOKEN environment variable is not set');
  }

  if (!PHONE_NUMBER_ID) {
    console.error('[whatsapp.sendMessage] PHONE_NUMBER_ID is missing');
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


  try {
    const response = await axios.post(BASE_URL, payload, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[whatsapp.sendMessage] Success! Response status: ${response.status}`);
    console.log(`[whatsapp.sendMessage] Response data:`, JSON.stringify(response.data, null, 2));


    return response.data;
  } catch (error) {
    
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
