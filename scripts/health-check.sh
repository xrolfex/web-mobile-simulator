#!/bin/bash
echo "Checking API health..."
curl -s http://localhost:3000/api/health | python3 -m json.tool 2>/dev/null || echo "❌ API not responding"

echo ""
echo "Checking web server..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:80/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Web server responding (HTTP $HTTP_CODE)"
else
    echo "❌ Web server not responding (HTTP $HTTP_CODE)"
fi
