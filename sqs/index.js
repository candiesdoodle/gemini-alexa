const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { GoogleGenAI } = require("@google/genai");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const dynamoDB = new DynamoDBClient({});
const ssm = new SSMClient({});
const tableName = process.env.DYNAMODB_TABLE;
let ai;

async function getApiKey() {
    const command = new GetParameterCommand({
        Name: process.env.GEMINI_API_KEY,
        WithDecryption: true,
    });
    const response = await ssm.send(command);
    return response.Parameter.Value;
}

exports.handler = async (event) => {
    if (!ai) {
        const apiKey = await getApiKey();
        ai = new GoogleGenAI({ apiKey: apiKey });
    }

    for (const record of event.Records) {
        const request = JSON.parse(record.body);
        const { requestId, prompt, lastRequestId } = request;

        // 1. Fetch previous history if lastRequestId exists
        let history = [];
        if (lastRequestId) {
            try {
                const historyResult = await dynamoDB.send(new GetItemCommand({
                    TableName: tableName,
                    Key: { requestId: { S: lastRequestId } },
                }));

                if (historyResult.Item && historyResult.Item.history) {
                    history = JSON.parse(historyResult.Item.history.S);
                }
            } catch (e) {
                console.error("Error fetching history:", e);
                // Continue with empty history if fetch fails
            }
        }

        // 2. Call the Gemini API with the retrieved history
        const chat = ai.chats.create({
            model: 'gemini-2.5-flash-lite',
            history: history
        });
        const response = await chat.sendMessage({
          message: prompt,
          config: {systemInstruction: 'You are an expert voice based AI assistant. keep your responses succint'},
        });
        const text = response.text;

        // 3. Construct the new history
        const newHistory = [
            ...history,
            { role: "user", parts: [{ text: prompt }] },
            { role: "model", parts: [{ text: text }] }
        ];

        // 4. Write the new item with response and updated history
        const ttl = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
        await dynamoDB.send(new PutItemCommand({
            TableName: tableName,
            Item: {
                requestId: { S: requestId },
                response: { S: text },
                history: { S: JSON.stringify(newHistory) },
                ttl: { N: ttl.toString() },
            },
        }));
    }
};
