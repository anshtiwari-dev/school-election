
#!/bin/bash
echo "=========================================="
echo " 🧹 Performing Selective Data Reset...    "
echo "=========================================="

# Stop running node server if active
pkill -f "node server.js" 2>/dev/null

# Clear only volatile operational databases, KEEP booths, staff, and archives safe
rm -rf data/voters.db 2>/dev/null
rm -rf data/votes.db 2>/dev/null
rm -rf data/parties.db 2>/dev/null
rm -rf data/systemHistory.db 2>/dev/null
rm -rf data/schedules.db 2>/dev/null

echo "✅ Volatile databases cleared!"
echo "🛡️ Polling booths, staff accounts, and historical archives PROTECTED & RETAINED."
echo "🚀 Starting fresh server..."
echo "=========================================="

node server.js
