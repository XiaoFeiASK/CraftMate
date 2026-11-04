#!/bin/bash
# 测试 CraftMate 系统启动

set -e

echo "========================================"
echo "CraftMate 启动测试"
echo "========================================"
echo ""

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "❌ .env 文件不存在"
    exit 1
fi
echo "✅ .env 文件存在"

# 检查必要的环境变量
source .env

if [ -z "$CRAFTMATE_MODEL_KEY" ]; then
    echo "❌ CRAFTMATE_MODEL_KEY 未设置"
    exit 1
fi
echo "✅ CRAFTMATE_MODEL_KEY 已设置"

if [ -z "${TTS_PRIMARY_KEY:-}" ]; then
    echo "⚠️  TTS_PRIMARY_KEY 未设置（语音将不可用）"
else
    echo "✅ TTS_PRIMARY_KEY 已设置"
fi

echo ""
echo "========================================"
echo "运行测试套件"
echo "========================================"
npm test

echo ""
echo "========================================"
echo "测试 DeepSeek 模型连接"
echo "========================================"

cat > test-model-temp.mjs << 'EOF'
const url = process.env.CRAFTMATE_MODEL_URL || 'https://www.yyapi.cloud/v1';
const model = process.env.CRAFTMATE_MODEL || 'deepseek-v4.1-flash';
const apiKey = process.env.CRAFTMATE_MODEL_KEY;
if (!apiKey) {
  console.error('CRAFTMATE_MODEL_KEY is empty');
  process.exit(1);
}

console.log('Testing DeepSeek model via YYAPI...');
console.log(`URL: ${url}`);
console.log(`Model: ${model}`);

const response = await fetch(`${url}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: model,
    messages: [{ role: 'user', content: '你好' }],
    max_tokens: 50
  })
});

const data = await response.json();
if (data.choices?.[0]?.message?.content) {
  console.log('\n✅ Model is working!');
} else {
  console.log('\n❌ Model test failed');
  console.log('Response:', JSON.stringify(data, null, 2));
  process.exit(1);
}
EOF

node --env-file=.env test-model-temp.mjs
rm test-model-temp.mjs

echo ""
echo "========================================"
echo "✅ 所有测试通过！"
echo "========================================"
echo ""
echo "现在可以启动系统："
echo "  npm run dev"
echo ""
echo "或单独启动 Voice 服务测试 TTS："
echo "  node --env-file=.env services/voice/src/main.ts"
echo ""
