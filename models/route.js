const { getDatabase } = require('../database');

/**
 * Find route by ID
 * @param {number} id - Route ID
 * @returns {Promise<Object|null>} Route object or null if not found
 */
async function findById(id) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM routes WHERE id = ?',
      [id],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      }
    );
  });
}

/**
 * Find all routes
 * @returns {Promise<Array>} Array of route objects
 */
async function findAll() {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM routes ORDER BY id ASC',
      [],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      }
    );
  });
}

module.exports = {
  findById,
  findAll
};
