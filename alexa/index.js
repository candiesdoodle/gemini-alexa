const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { randomUUID } = require("crypto");

const sqs = new SQSClient({});
const dynamoDB = new DynamoDBClient({});
const tableName = process.env.DYNAMODB_TABLE;

// Updated buildResponse function to handle session attributes
const buildResponse = (text, shouldEndSession = true, sessionAttributes = {}) => {
  const responsePayload = {
    outputSpeech: {
      type: "PlainText",
      text: text,
    },
    shouldEndSession: shouldEndSession,
  };

  // Add a reprompt if the session is not ending
  if (!shouldEndSession) {
    responsePayload.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: "Is there anything else?",
      },
    };
  }

  const response = {
    version: "1.0",
    response: responsePayload,
  };

  if (Object.keys(sessionAttributes).length > 0) {
    response.sessionAttributes = sessionAttributes;
  }
  return response;
};

// Function to poll DynamoDB for a result
const pollForResponse = async (requestId, timeout = 7000) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const params = {
            TableName: tableName,
            Key: { requestId: { S: requestId } },
        };
        const command = new GetItemCommand(params);
        const result = await dynamoDB.send(command);

        if (result.Item) {
            return result.Item.response.S;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
};


exports.handler = async (event) => {
  const requestType = event.request.type;
  const sessionAttributes = event.session.attributes || {};

  if (requestType === 'LaunchRequest') {
    return buildResponse("Welcome to Gemini. You can ask me anything.", false, sessionAttributes);
  }

  if (requestType === 'IntentRequest') {
    const intentName = event.request.intent.name;

    if (intentName === 'CatchAll') {
      const prompt = event.request.intent.slots.text.value.toLowerCase();

      const lastResponsePhrases = [
        'last response',
        'what was the last response',
        'get the last response',
        'what did you say',
        'can you repeat that',
        'say that again',
        'i am waiting',
        'so whats the answer',
        'get the answer',
        'still waiting',
        'go ahead',
        'okay waiting'
      
      ];

      // Check for session end phrases first
      if (prompt === 'no' || prompt === 'thank you') {
        return buildResponse("Goodbye!", true, {});
      }

      // Check for "last response" command
      else if (lastResponsePhrases.some(phrase => prompt.includes(phrase))) {
        if (!sessionAttributes.lastRequestId) {
            return buildResponse("I don't have a recent request to look for. Please ask a question first.", false, sessionAttributes);
        }
        const responseText = await pollForResponse(sessionAttributes.lastRequestId, 2500);
        if (responseText) {
            return buildResponse(responseText, false, sessionAttributes);
        } else {
            return buildResponse("I don't have a response for you yet. Please wait a moment and try again.", false, sessionAttributes);
        }
      }
      
      // Check for "help" command
      else if (prompt === 'help') {
        const helpText = "You can ask me any question, for example, 'ask what is the tallest building in the world'. If a response takes too long, you can say 'what was the last response'. How can I help?";
        return buildResponse(helpText, false, sessionAttributes);
      }

      // Default action: treat as a new prompt for Gemini
      else {
        const requestId = randomUUID();
        const request = {
          requestId: requestId,
          sessionId: event.session.sessionId,
          prompt: prompt,
          lastRequestId: sessionAttributes.lastRequestId // Pass the last request ID
        };

        const sendCommand = new SendMessageCommand({
          QueueUrl: process.env.REQUESTS_QUEUE_URI,
          MessageBody: JSON.stringify(request),
        });

        await sqs.send(sendCommand);

        const responseText = await pollForResponse(requestId);
        
        // ALWAYS update the lastRequestId for the new turn
        sessionAttributes.lastRequestId = requestId;

        if (responseText) {
            return buildResponse(responseText, false, sessionAttributes);
        } else {
            return {
              version: "1.0",
              sessionAttributes: sessionAttributes,
              response: {
                outputSpeech: {
                  type: "PlainText",
                  text: "Your request is taking a moment. To hear the response, say 'what was the last response'.",
                },
                shouldEndSession: false,
              },
            };
        }
      }
    }

    // Standard Amazon intents can remain for non-verbal triggers or edge cases
    if (intentName === 'AMAZON.HelpIntent') {
        const helpText = "You can ask me any question, for example, 'ask what is the tallest building in the world'. If a response takes too long, you can say 'what was the last response'. How can I help?";
        return buildResponse(helpText, false, sessionAttributes);
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
        return buildResponse("Goodbye!", true, {}); // End session, clear attributes
    }

    if (intentName === 'AMAZON.FallbackIntent') {
        const fallbackText = "Sorry, I'm not sure how to handle that. You can ask me a question, like 'ask what is the capital of France'. For the last response, say 'what was the last response'. How can I help?";
        return buildResponse(fallbackText, false, sessionAttributes);
    }
  }

  return buildResponse("Sorry, I'm not sure how to handle that request. Please start again.", true, {});
};