#!/usr/bin/env pwsh
# Test: Account switching & order history isolation (Issue #30)

$sessionId1 = [guid]::NewGuid().ToString()
$sessionId2 = [guid]::NewGuid().ToString()

Write-Host "=== Issue #30: Order Isolation & Account Switch Validation ===" -ForegroundColor Green
Write-Host "Session 1: $sessionId1" -ForegroundColor Cyan
Write-Host "Session 2: $sessionId2`n" -ForegroundColor Cyan

# 1. Create Cart for Guest Session 1
Write-Host "1️⃣  Creating cart for Guest Session 1..." -ForegroundColor Yellow
$cartBody = @{
    items = @(@{ productId = "cmnbrumyy003il0tsup7oh1nn"; quantity = 1 })
    cityId = $null
} | ConvertTo-Json

$cartRes = Invoke-WebRequest -Uri "http://localhost:3000/api/carts" `
    -Method POST `
    -Headers @{ "x-session-id" = $sessionId1; "Content-Type" = "application/json" } `
    -Body $cartBody `
    -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json

if (-not $cartRes.success) {
    Write-Host "❌ Cart creation failed: $($cartRes.error)" -ForegroundColor Red
    exit 1
}

$cartId = $cartRes.data.id
Write-Host "✅ Cart created: $cartId for Session 1" -ForegroundColor Green

# 2. Create Order for Guest Session 1
Write-Host "`n2️⃣  Creating order for Guest Session 1..." -ForegroundColor Yellow
$phone1 = "300$(Get-Random -Minimum 1000000 -Maximum 9999999)"
$orderBody = @{
    cartId = $cartId
    customerPhone = $phone1
    customerName = "Guest User 1"
} | ConvertTo-Json

$orderRes = Invoke-WebRequest -Uri "http://localhost:3000/api/orders" `
    -Method POST `
    -Headers @{ "x-session-id" = $sessionId1; "Content-Type" = "application/json" } `
    -Body $orderBody `
    -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json

if (-not $orderRes.success) {
    Write-Host "❌ Order creation failed: $($orderRes.error)" -ForegroundColor Red
    exit 1
}

$orderNumber1 = $orderRes.data.orderNumber
Write-Host "✅ Order created: #$orderNumber1 for Session 1" -ForegroundColor Green

# 3. Retrieve Orders for Session 1
Write-Host "`n3️⃣  Retrieving orders for Session 1..." -ForegroundColor Yellow
$mineRes1 = Invoke-WebRequest -Uri "http://localhost:3000/api/orders/mine" `
    -Method GET `
    -Headers @{ "x-session-id" = $sessionId1; "Content-Type" = "application/json" } `
    -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json

if ($mineRes1.data.Count -ne 1) {
    Write-Host "❌ Expected 1 order for Session 1, found $($mineRes1.data.Count)" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Session 1 sees order #$($mineRes1.data[0].orderNumber)" -ForegroundColor Green

# 4. Check Order Isolation for Session 2 (Rotated Guest Session)
Write-Host "`n4️⃣  Retrieving orders for Session 2 (New Guest Session after logout/rotation)..." -ForegroundColor Yellow
$mineRes2 = Invoke-WebRequest -Uri "http://localhost:3000/api/orders/mine" `
    -Method GET `
    -Headers @{ "x-session-id" = $sessionId2; "Content-Type" = "application/json" } `
    -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json

if ($mineRes2.data.Count -ne 0) {
    Write-Host "❌ Session 2 incorrectly sees $($mineRes2.data.Count) order(s) from Session 1!" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Session 2 correctly sees 0 orders (Isolated from Session 1)" -ForegroundColor Green

Write-Host "`n🎉 SUCCESS: Account switch and order isolation verified successfully!" -ForegroundColor Green
