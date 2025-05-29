// Try to load .env file if it exists, but Replit Secrets will be used automatically
try {
  require('dotenv').config();
} catch (error) {
  console.log('No .env file found, using Replit Secrets');
}

const express = require('express');
const bodyParser = require('body-parser');
const { App } = require('@slack/bolt');
const axios = require('axios');

// Initialize Express app
const expressApp = express();
expressApp.use(bodyParser.json());
expressApp.use(bodyParser.urlencoded({ extended: true }));

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Make sure we're subscribed to all the necessary events
const requiredScopes = [
  'commands',               // For slash commands and shortcuts
  'chat:write',             // For posting messages
  'chat:write.public',      // For posting to channels without joining
  'im:history',             // For reading DM history
  'im:write',               // For writing to DMs
  'channels:history',       // For reading channel history (for message context)
  'groups:history',         // For reading private channel history
  'mpim:history'            // For reading multi-person DM history
];

// Store ongoing decision memo conversations
const conversations = {};

// Handle the /decisionmemo slash command to start a DM conversation
app.command('/decisionmemo', async ({ command, ack, client, respond }) => {
  // Acknowledge command request
  await ack();

  try {
    // Open a DM with the user first to get the DM channel ID
    const dmResult = await client.conversations.open({
      users: command.user_id
    });

    const dmChannelId = dmResult.channel.id;

    // Create a link to the DM
    const dmLink = `slack://channel?team=${command.team_id}&id=${dmChannelId}`;

    // Let the user know we're starting a DM with a clickable link
    await respond({
      response_type: 'ephemeral', // Only visible to the user who triggered the command
      text: `I'll send you a direct message to help create your Decision Memo. <${dmLink}|Click here to open our conversation>`
    });

    // Store conversation state
    conversations[dmChannelId] = {
      userId: command.user_id,
      stage: 'started',
      context: '',
      participants: ''
    };

    // Start the conversation in the DM with updated message and formatting
    await client.chat.postMessage({
      channel: dmChannelId,
      text: ":memo: I'll help you create a Decision Memo. *Please paste* the relevant conversation from Slack, a meeting transcript, or other notes so we can generate the memo. Include as much context as might be helpful.\n\n*Note:* If your transcript is too long to paste into Slack, you can upload a .txt file instead. (Respond with \"stop\" at any time to terminate this process)"
    });
  } catch (error) {
    console.error('Error starting DM conversation:', error);

    // Send an error message
    await respond({
      response_type: 'ephemeral',
      text: "Sorry, there was an error starting the Decision Memo process. Please try again."
    });
  }
});

// Handle the message shortcut
app.shortcut('call_decision_memo_tool', async ({ shortcut, ack, client }) => {
  // Acknowledge the shortcut request
  await ack();

  try {
    // Get the message text from the shortcut
    const messageText = shortcut.message.text || "";
    const messageUser = shortcut.message.user || "Unknown";

    // Open a DM with the user who triggered the shortcut
    const dmResult = await client.conversations.open({
      users: shortcut.user.id
    });

    const dmChannelId = dmResult.channel.id;

    // Create a link to the DM
    const dmLink = `slack://channel?team=${shortcut.team.id}&id=${dmChannelId}`;

    // If we're in a thread, get the thread timestamp
    const threadTs = shortcut.message.thread_ts || shortcut.message.ts;

    // Post a message in the thread that only mentions the user who triggered the shortcut
    // This will appear in the thread and notify only that user
    try {
      await client.chat.postMessage({
        channel: shortcut.channel.id,
        thread_ts: threadTs,
        text: `<@${shortcut.user.id}> :memo: I'm creating a Decision Memo based on this thread. <${dmLink}|Click here to open our conversation> and I'll guide you through the process.`,
        unfurl_links: false
      });
    } catch (error) {
      console.log("Error sending thread notification:", error);
      // Continue with the process anyway
    }

    // Try to post a message in the thread
    let threadMessages = [shortcut.message];
    let threadContent = `<@${messageUser}>: ${messageText}`;
    let threadFetchFailed = false;

    // Try to fetch all thread messages if we're in a thread
    if (shortcut.message.thread_ts) {
      try {
        // Use conversations.replies to get all messages in the thread
        const threadResult = await client.conversations.replies({
          channel: shortcut.channel.id,
          ts: shortcut.message.thread_ts
        });

        // Check if we really got all the thread messages
        if (threadResult.messages && threadResult.messages.length > 0) {
          // Store all messages temporarily 
          const allMessages = threadResult.messages;

          // Filter out any messages from bots (messages with bot_id property exist)
          // Also filter out app messages from this bot or any other bot
          const humanMessages = allMessages.filter(msg => {
            return !msg.bot_id && !msg.subtype;
          });

          console.log(`Thread contains ${allMessages.length} total messages, ${humanMessages.length} human messages`);

          // Update threadMessages to only contain human messages
          threadMessages = humanMessages;

          // Update context using only the human messages
          threadContent = humanMessages.map(msg => {
            const sender = msg.user ? `<@${msg.user}>` : 'Unknown';
            return `${sender}: ${msg.text}`;
          }).join('\n\n');
        }
      } catch (threadError) {
        console.error('Error fetching thread messages:', threadError);
        threadFetchFailed = true;
      }
    }

    // Store conversation state
    conversations[dmChannelId] = {
      userId: shortcut.user.id,
      stage: 'asking_questions',
      context: threadContent,
      participants: '',
      rawMessages: threadMessages,
      originalChannel: shortcut.channel.id,
      threadTs: shortcut.message.thread_ts || shortcut.message.ts
    };

    // Show the user what was captured
    if (shortcut.message.thread_ts && threadFetchFailed) {
      // Bot is not in the channel and can't access thread messages
      const channelId = shortcut.channel.id;

      let capturedPreviewText = `:warning: Thanks for using the Decision Memo tool. Before we can proceed, *I need to be added to the <#${channelId}> channel so I can access thread messages.*\n\n`;
      capturedPreviewText += "*To add me to the channel:*\n";
      capturedPreviewText += `1. Go to <#${channelId}>\n`;
      capturedPreviewText += "2. Type and send: `/invite @Decision Memo`\n";
      capturedPreviewText += "3. Launch the message shortcut again in your thread\n\n";

      // Let the user know
      await client.chat.postMessage({
        channel: dmChannelId,
        text: capturedPreviewText
      });

      // Clean up the conversation since we're stopping until the user tries again
      delete conversations[dmChannelId];
      return;
    } else if (shortcut.message.thread_ts && !threadFetchFailed) {
      // We got thread messages successfully
      // First, provide context about what we're doing
      await client.chat.postMessage({
        channel: dmChannelId,
        text: `:memo: I'm creating a Decision Memo based on the thread in <#${shortcut.channel.id}>. (Respond with "stop" at any time to terminate this process)`
      });

      // Get the first message in the thread (the parent message)
      let parentMessage = threadMessages[0];
      for (let msg of threadMessages) {
        if (!msg.thread_ts || msg.thread_ts === msg.ts) {
          // This is a parent message (either it has no thread_ts or its thread_ts equals its own ts)
          parentMessage = msg;
          break;
        }
      }

      // Format the parent message for display
      const parentSender = parentMessage.user ? `<@${parentMessage.user}>` : 'Unknown';
      const parentText = parentMessage.text || '';
      const parentLines = parentText.split('\n');
      const blockquotedParent = parentLines.map(line => `>${line}`).join('\n');

      // Then show the first message and that we've captured everything
      let previewMessage = `I've captured the thread starting with this message:\n\n`;
      previewMessage += `${blockquotedParent}\n\n`;
      previewMessage += "I'm analyzing the conversation to determine if I need any clarifying information...";

      // Let the user know we're starting a Decision Memo process
      await client.chat.postMessage({
        channel: dmChannelId,
        text: previewMessage
      });

      // Generate clarifying questions directly
      try {
        console.log("Generating clarifying questions for thread...");

        // Call the Claude API to generate clarifying questions
        const clarifyingQuestions = await generateClarifyingQuestions(threadContent, '');

        console.log(`Generated ${clarifyingQuestions ? clarifyingQuestions.length : 0} clarifying questions`);

        // Initialize arrays for questions and answers
        conversations[dmChannelId].clarifyingQuestions = clarifyingQuestions || [];

        // Always add the final catch-all question
        const finalQuestion = "Is there anything else I should know about this decision before proceeding?";
        conversations[dmChannelId].clarifyingQuestions.push(finalQuestion);

        // Format the questions as a numbered list
        let questionsMessage = "*Clarifying questions❓*\n";

        // Add each question with a number and proper spacing for readability
        for (let i = 0; i < conversations[dmChannelId].clarifyingQuestions.length; i++) {
          questionsMessage += `${i+1}) ${conversations[dmChannelId].clarifyingQuestions[i]}\n\n`;
        }

        questionsMessage += "*Please answer each question in order.* You can number your responses for clarity. 👀";

        // Ask all the questions at once
        await client.chat.postMessage({
          channel: dmChannelId,
          text: questionsMessage
        });
      } catch (error) {
        console.error('Error generating clarifying questions:', error);

        // If there's an error, generate the memo without clarifying questions
        await client.chat.postMessage({
          channel: dmChannelId,
          text: "I had trouble generating clarifying questions, but I'll create a Decision Memo based on the information I have. This may take a moment... ⏳"
        });

        try {
          // Generate the Decision Memo without clarification
          const decisionMemo = await generateDecisionMemo(threadContent, '');

          // Process and send the memo
          processMemoAndRespond(client, dmChannelId, decisionMemo);
        } catch (memoError) {
          console.error('Error generating memo:', memoError);
          await client.chat.postMessage({
            channel: dmChannelId,
            text: "Sorry, I encountered an error generating the memo. Please try again or contact the administrator."
          });
        }

        // Clean up
        delete conversations[dmChannelId];
      }
      return; // Skip the rest of the function since we've already handled everything
    } else {
      // We only have one message (not in a thread)
      // First, provide context about what we're doing
      await client.chat.postMessage({
        channel: dmChannelId,
        text: `:memo: I'm creating a Decision Memo based on a message from <#${shortcut.channel.id}>. (Respond with "stop" at any time to terminate this process)`
      });

      // Format the message for display
      const sender = messageUser ? `<@${messageUser}>` : 'Unknown';
      const messageLines = messageText.split('\n');
      const blockquotedText = messageLines.map(line => `>${line}`).join('\n');

      // Then show the message that we've captured
      let previewMessage = `I've captured the message:\n\n`;
      previewMessage += `${blockquotedText}\n\n`;
      previewMessage += "I'm analyzing the conversation to determine if I need any clarifying information...";

      // Send the preview
      await client.chat.postMessage({
        channel: dmChannelId,
        text: previewMessage
      });

      // Now we'll immediately analyze and ask clarifying questions
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "I'm analyzing the conversation to determine if I need any clarifying information..."
      });

      try {
        console.log("Generating clarifying questions for message...");

        // Call the Claude API to generate clarifying questions
        const clarifyingQuestions = await generateClarifyingQuestions(messageText, '');

        console.log(`Generated ${clarifyingQuestions ? clarifyingQuestions.length : 0} clarifying questions`);

        // Initialize arrays for questions and answers
        conversations[dmChannelId].clarifyingQuestions = clarifyingQuestions || [];

        // Always add the final catch-all question
        const finalQuestion = "Is there anything else I should know about this decision before proceeding?";
        conversations[dmChannelId].clarifyingQuestions.push(finalQuestion);

        // Format the questions as a numbered list
        let questionsMessage = "*Clarifying questions❓*\n";

        // Add each question with a number and proper spacing for readability
        for (let i = 0; i < conversations[dmChannelId].clarifyingQuestions.length; i++) {
          questionsMessage += `${i+1}) ${conversations[dmChannelId].clarifyingQuestions[i]}\n\n`;
        }

        questionsMessage += "*Please answer each question in order.* You can number your responses for clarity. 👀";

        // Ask all the questions at once
        await client.chat.postMessage({
          channel: dmChannelId,
          text: questionsMessage
        });
      } catch (error) {
        console.error('Error generating clarifying questions:', error);

        // If there's an error, generate the memo without clarifying questions
        await client.chat.postMessage({
          channel: dmChannelId,
          text: "I had trouble generating clarifying questions, but I'll create a Decision Memo based on the information I have. This may take a moment... ⏳"
        });

        try {
          // Generate the Decision Memo without clarification
          const decisionMemo = await generateDecisionMemo(messageText, '');

          // Process and send the memo
          processMemoAndRespond(client, dmChannelId, decisionMemo);
        } catch (memoError) {
          console.error('Error generating memo:', memoError);
          await client.chat.postMessage({
            channel: dmChannelId,
            text: "Sorry, I encountered an error generating the memo. Please try again or contact the administrator."
          });
        }

        // Clean up
        delete conversations[dmChannelId];
      }
    }
  } catch (error) {
    console.error('Error processing message shortcut:', error);

    // Try to notify the user of the error in the thread
    try {
      // Get the thread ts if it exists
      const errorThreadTs = shortcut.message?.thread_ts || shortcut.message?.ts;

      // Post an error message in the thread mentioning only the user who triggered the shortcut
      if (shortcut.channel && shortcut.user && errorThreadTs) {
        await client.chat.postMessage({
          channel: shortcut.channel.id,
          thread_ts: errorThreadTs,
          text: `:warning: <@${shortcut.user.id}> Sorry, there was an error processing your Decision Memo request. Please try again.`,
          unfurl_links: false
        });
      }
    } catch (messageError) {
      console.error('Failed to send error notification:', messageError);
    }
  }
});

// Helper function to process memo and respond
async function processMemoAndRespond(client, channelId, decisionMemo) {
  // Split the memo to extract the title if it exists
  const memoLines = decisionMemo.split('\n');
  let memoTitle = "";
  let memoContent = decisionMemo;

  // If the first line contains a title (starts with #), extract it
  if (memoLines[0].startsWith('# ') || memoLines[0].startsWith('#')) {
    memoTitle = memoLines[0].replace(/^#\s*/, '').replace(/:\s*$/, '');
    memoContent = memoLines.slice(1).join('\n').trim();
  }

  // First, send the intro message
  await client.chat.postMessage({
    channel: channelId,
    text: "✅ Here's your Decision Memo that you can copy to Notion:"
  });

  // Then send the actual memo with proper formatting
  await client.chat.postMessage({
    channel: channelId,
    text: memoTitle ? `*${memoTitle}*\n\n${memoContent}` : memoContent
  });

  // Let the user know they can run the command again
  await client.chat.postMessage({
    channel: channelId,
    text: "🙌 Thanks for using the Decision Memo tool. Be sure to add your memo to the Decision Log and make any necessary refinements before publishing.\n\n🔁 Start again anytime with the `/decisionmemo` command or via the message shortcut. Please share any constructive feedback about this tool directly with @ryan."
  });
}

// Listen for messages in DMs
app.message(async ({ message, client }) => {
  // Check if this is a DM
  if (message.channel_type !== 'im') return;

  // Check if this DM is part of an ongoing conversation
  const conversation = conversations[message.channel];
  if (!conversation) return;

  try {
    // Check if the user wants to stop the process
    if (message.text && message.text.toLowerCase().trim() === 'stop') {
      await client.chat.postMessage({
        channel: message.channel,
        text: "🛑 I've stopped the Decision Memo process. 🔁 Start again anytime with the `/decisionmemo` command or via the message shortcut. Please share any constructive feedback about this tool directly with @ryan."
      });

      // Clean up the conversation
      delete conversations[message.channel];
      return;
    }

    // Process based on the current stage
    if (conversation.stage === 'started') {
      // Check if there's a file upload
      if (message.files && message.files.length > 0) {
        // Handle file upload
        await handleFileUpload(client, conversation, message);
      } else {
        // Save the context
        conversation.context = message.text;
        conversation.stage = 'asking_questions';

        // Let the user know we're analyzing the conversation
        await client.chat.postMessage({
          channel: message.channel,
          text: "Thanks for providing the context. I'm analyzing the conversation to determine if I need any clarifying information..."
        });

        try {
          // Generate clarifying questions immediately
          console.log("Generating clarifying questions for provided context...");
          const clarifyingQuestions = await generateClarifyingQuestions(conversation.context, '');
          console.log(`Generated ${clarifyingQuestions ? clarifyingQuestions.length : 0} clarifying questions`);

          // Initialize questions array
          conversation.clarifyingQuestions = clarifyingQuestions || [];

          // Always add the final catch-all question
          const finalQuestion = "Is there anything else I should know about this decision before proceeding?";
          conversation.clarifyingQuestions.push(finalQuestion);

          // Format the questions as a numbered list with proper spacing
          let questionsMessage = "*Clarifying questions❓*\n";

          // Add each question with a number and proper spacing for readability
          for (let i = 0; i < conversation.clarifyingQuestions.length; i++) {
            questionsMessage += `${i+1}) ${conversation.clarifyingQuestions[i]}\n\n`;
          }

          questionsMessage += "*Please answer each question in order.* You can number your responses for clarity. 👀";

          // Ask all the questions at once
          await client.chat.postMessage({
            channel: message.channel,
            text: questionsMessage
          });
        } catch (error) {
          console.error('Error generating clarifying questions:', error);

          // If there's an error, just generate the memo without clarifying questions
          await client.chat.postMessage({
            channel: message.channel,
            text: "I had trouble generating clarifying questions, but I'll create a Decision Memo based on the information I have. This may take a moment... ⏳"
          });

          try {
            // Generate the Decision Memo without clarification
            const decisionMemo = await generateDecisionMemo(conversation.context, '');

            // Process and send the memo
            await processMemoAndRespond(client, message.channel, decisionMemo);
          } catch (memoError) {
            console.error('Error generating memo:', memoError);
            await client.chat.postMessage({
              channel: message.channel,
              text: "Sorry, I encountered an error generating the memo. Please try again or contact the administrator."
            });
          }

          // Clean up
          delete conversations[message.channel];
        }
      }
    }
    else if (conversation.stage === 'asking_questions') {
      // Save the answer to the clarifying question - assume the user is answering all questions at once
      conversation.clarifyingAnswers = message.text;

      // We have all the answers, generate the memo
      conversation.stage = 'generating';

      // Let the user know we're processing
      await client.chat.postMessage({
        channel: message.channel,
        text: "Thanks for the information. I'm now generating your Decision Memo. This may take a moment... ⏳"
      });

      try {
        // Generate the Decision Memo with clarifying information
        const decisionMemo = await generateDecisionMemoWithClarification(
          conversation.context, 
          '',
          conversation.clarifyingQuestions,
          [conversation.clarifyingAnswers] // Wrap the answers in an array since we're treating it as a single response
        );

        // Check if the conversation still exists (user might have stopped the process)
        if (!conversations[message.channel]) {
          return;
        }

        // Process and send the memo
        await processMemoAndRespond(client, message.channel, decisionMemo);
      } catch (error) {
        console.error('Error generating memo with clarification:', error);

        // Send an error message
        await client.chat.postMessage({
          channel: message.channel,
          text: "Sorry, I encountered an error generating the memo. Please try again or contact the administrator."
        });
      }

      // Clean up
      delete conversations[message.channel];
    }
  } catch (error) {
    console.error('Error processing message:', error);

    // Send an error message
    await client.chat.postMessage({
      channel: message.channel,
      text: "Sorry, there was an error processing your message. Please try again."
    });
  }
});

// Handle file uploads - Updated with improved error handling
async function handleFileUpload(client, conversation, message) {
  const file = message.files[0];

  try {
    // Check if it's a text file
    const acceptableTypes = ['text', 'txt', 'plain'];
    if (!acceptableTypes.includes(file.filetype.toLowerCase())) {
      await client.chat.postMessage({
        channel: message.channel,
        text: "I can only process text (.txt) files. Please upload a text file or paste your context directly."
      });
      return;
    }

    console.log('Attempting to process file upload of type:', file.filetype);

    // Get the file info - don't include file contents as that requires different permissions
    const fileInfo = await client.files.info({
      file: file.id
    });

    console.log('Retrieved file info successfully');

    // Download the file content
    try {
      const fileContentResponse = await axios.get(fileInfo.file.url_private, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
        }
      });

      console.log('Downloaded file content successfully, size:', fileContentResponse.data.length);

      // Save the file content as context (trimming if needed)
      const maxLength = 25000;
      let fileContent = fileContentResponse.data;

      if (typeof fileContent !== 'string') {
        fileContent = JSON.stringify(fileContent);
      }

      if (fileContent.length > maxLength) {
        fileContent = fileContent.substring(0, maxLength) + 
          "\n\n[Note: File was truncated as it exceeded maximum length. Only the first portion is being processed.]";
      }

      conversation.context = fileContent;

      // Let the user know we're analyzing the file
      await client.chat.postMessage({
        channel: message.channel,
        text: "Thanks for uploading the file. I'm analyzing the content to determine if I need any clarifying information..."
      });

      try {
        // Set to asking questions stage immediately
        conversation.stage = 'asking_questions';

        // Generate clarifying questions immediately
        console.log("Generating clarifying questions for file content...");
        const clarifyingQuestions = await generateClarifyingQuestions(conversation.context, '');
        console.log(`Generated ${clarifyingQuestions ? clarifyingQuestions.length : 0} clarifying questions`);

        // Initialize questions array
        conversation.clarifyingQuestions = clarifyingQuestions || [];

        // Always add the final catch-all question
        const finalQuestion = "Is there anything else I should know about this decision before proceeding?";
        conversation.clarifyingQuestions.push(finalQuestion);

        // Format the questions as a numbered list with proper spacing
        let questionsMessage = "*Clarifying questions❓*\n";

        // Add each question with a number and proper spacing for readability
        for (let i = 0; i < conversation.clarifyingQuestions.length; i++) {
          questionsMessage += `${i+1}) ${conversation.clarifyingQuestions[i]}\n\n`;
        }

        questionsMessage += "*Please answer each question in order.* You can number your responses for clarity. 👀";

        // Ask all the questions at once
        await client.chat.postMessage({
          channel: message.channel,
          text: questionsMessage
        });
      } catch (error) {
        console.error('Error generating clarifying questions for file:', error);

        // If there's an error, just generate the memo without clarifying questions
        await client.chat.postMessage({
          channel: message.channel,
          text: "I had trouble generating clarifying questions, but I'll create a Decision Memo based on the information I have. This may take a moment... ⏳"
        });

        try {
          // Generate the Decision Memo without clarification
          const decisionMemo = await generateDecisionMemo(conversation.context, '');

          // Process and send the memo
          await processMemoAndRespond(client, message.channel, decisionMemo);
        } catch (memoError) {
          console.error('Error generating memo from file:', memoError);
          await client.chat.postMessage({
            channel: message.channel,
            text: "Sorry, I encountered an error generating the memo. Please try again or contact the administrator."
          });
        }

        // Clean up
        delete conversations[message.channel];
      }

    } catch (downloadError) {
      console.error('Error downloading file:', downloadError);
      throw new Error('Could not download file content: ' + downloadError.message);
    }

  } catch (error) {
    console.error('Error handling file upload:', error);

    // Provide clear guidance based on the error
    if (error.data && error.data.error === 'missing_scope') {
      await client.chat.postMessage({
        channel: message.channel,
        text: "Sorry, I don't have permission to read files yet. The app needs to be reinstalled with the 'files:read' permission. Please paste the content directly instead or contact the administrator to update permissions."
      });
    } else {
      await client.chat.postMessage({
        channel: message.channel,
        text: "Sorry, there was an error processing your file. Please try pasting the content directly instead."
      });
    }
  }
}

// Function to generate clarifying questions using Claude API
async function generateClarifyingQuestions(context, participants) {
  try {
    console.log("Starting Claude API call for clarifying questions...");

    // Prepare the request to Claude API with updated prompt
    const prompt = `
You are a seasoned executive decision-maker at a company that values first-principles thinking, ownership, mission focus, and the courage to speak truth. You're analyzing a conversation to identify if any critical information is missing to create a comprehensive Decision Memo.

The conversation context is:
${context}

${participants ? `The participants are: ${participants}` : ''}

The Decision Memo needs to answer these five questions:
1. What is the choice you made?
2. Why make this decision? What were the factors involved?
3. What are the risks of making this decision?
4. What is the compensation / reward for taking those risks?
5. What other choices did you consider?

As an executive with strong strategic vision, apply your judgment to determine if truly essential information is missing. Ask 1-2 high-impact questions that would help you understand:

- The first-principles reasoning behind this decision (getting to the root of the problem)
- How this decision connects to broader mission objectives or long-term strategy
- The ownership perspective (who's taking responsibility, what "bet" is being placed)
- Whether alternatives were thoroughly considered from first principles
- Qualitative assessment of risks (not just listing them)
- Both direct and indirect benefits or strategic advantages

If it's not clear from the context who key participants are and what their roles are, you should ask about that, but ONLY if it's truly necessary to understand the decision context.

Do not ask questions merely for curiosity or implementation details - focus on questions that would substantially improve the strategic depth of the Decision Memo.

Format your response as a JSON array of strings, with no more than 2 SPECIFIC questions. Example:
["What fundamental problem or opportunity is this decision addressing at its root?"]

If the conversation already provides sufficient strategic context and first-principles reasoning, return an empty array:
[]

DO NOT include a generic question like "Is there anything else I should know about this decision before proceeding?" in your response - this question will be asked separately.
`;

    // Call Claude API - Updated to use Claude 3.7 Sonnet
    console.log("Sending request to Claude API...");
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      }
    });

    console.log("Received response from Claude API");

    // Parse the response to get the questions
    const messageContent = response.data.content[0].text;
    console.log("Claude API response:", messageContent);

    try {
      // Try to parse as JSON
      const questions = JSON.parse(messageContent);

      // Ensure we never have more than 2 questions
      const limitedQuestions = Array.isArray(questions) ? questions.slice(0, 2) : [];
      console.log("Successfully parsed questions:", limitedQuestions);
      return limitedQuestions;
    } catch (parseError) {
      console.error('Error parsing questions as JSON:', parseError);
      // If parsing fails, try to extract questions using regex
      const matches = messageContent.match(/\[(.*)\]/s);
      if (matches && matches[1]) {
        const questionsText = matches[1];
        // Split by commas and clean up
        const extractedQuestions = questionsText.split('","')
          .map(q => q.replace(/^"|"$/g, '').replace(/^\["|"\]$/g, '').trim())
          .filter(q => q.length > 0);
        // Limit to at most 2 questions
        console.log("Extracted questions via regex:", extractedQuestions.slice(0, 2));
        return extractedQuestions.slice(0, 2);
      }
      // If all else fails, return no questions
      console.log("Couldn't parse questions, returning empty array");
      return [];
    }
  } catch (error) {
    console.error('Error generating clarifying questions:', error);
    return []; // Return empty array on error
  }
}

// Function to generate a Decision Memo using Claude API
async function generateDecisionMemo(context, participants) {
  try {
    console.log("Starting Claude API call for decision memo...");

    // Prepare the request to Claude API with updated formatting instructions
    const prompt = `
You are writing a Decision Memo as an executive who values first-principles thinking, ownership, mission alignment, and truth-speaking.

The conversation context is:
${context}

${participants ? `The participants are: ${participants}` : ''}

Create a Decision Memo that answers these five questions:
1. What is the choice you made?
2. Why make this decision? What were the factors involved?
3. What are the risks of making this decision?
4. What is the compensation / reward for taking those risks?
5. What other choices did you consider?

Begin with a concise title for the decision memo in the format:
# [Title of Decision]

For example:
# Renaming Product Indices

Then follow with these exact headings in Slack bold format (using asterisks):
*What is the choice you made?*
[Answer - be clear and concise about the decision made]

*Why make this decision? What were the factors involved?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

*What are the risks of making this decision?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

*What is the compensation / reward for taking those risks?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

*What other choices did you consider?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

IMPORTANT FORMATTING INSTRUCTIONS:
1. Each bullet point should begin with a single asterisk (*) immediately followed by text with no space in between.
2. Do not use nested formatting within bullet points - avoid using bold or other special formatting inside bullet points.
3. If you need to emphasize a point, use ALL CAPS for emphasis instead.
4. Keep all bullet points as single, continuous lines of text.

IMPORTANT STRUCTURE GUIDELINES:
1. Vary your approach to each section based on what's most relevant - some sections may need only 2-3 key points while others might require more depth.
2. Prioritize quality over quantity - it's better to have 3 insightful points than 6 superficial ones.
3. Consider the relative importance of each section for this particular decision - not all sections need equal detail.
4. For the most nuanced or complex points, consider using a brief paragraph instead of a bullet point when it would be clearer.
5. Make the memo feel organic and thoughtful rather than formulaic - avoid having exactly the same number of points in each section.

Be concise but thorough in your content. Don't fabricate information, but do connect the decision to deeper strategic thinking where the connection is clear from the context.
`;

    // Call Claude API - Updated to use Claude 3.7 Sonnet
    console.log("Sending request to Claude API for memo generation...");
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      }
    });

    console.log("Received memo from Claude API");

    // Return the Decision Memo
    return response.data.content[0].text;
  } catch (error) {
    console.error('Error generating Decision Memo:', error);

    // If API fails, fall back to a generic template
    return `# Decision Memo

*What is the choice you made?*
Based on the conversation, a decision was made but I couldn't generate a specific memo due to a technical issue.

*Why make this decision? What were the factors involved?*
*Several factors were likely considered

*What are the risks of making this decision?*
*There may be various risks associated with this decision

*What is the compensation / reward for taking those risks?*
*There are likely benefits to balance the risks

*What other choices did you consider?*
*Alternative approaches were likely evaluated

Note: There was an error connecting to the AI service. Please try again later.`;
  }
}

// Function to generate a Decision Memo with clarifying information
async function generateDecisionMemoWithClarification(context, participants, questions, answers) {
  try {
    console.log("Starting Claude API call for decision memo with clarification...");

    // Combine questions and answers into a single string
    let clarification = "";
    for (let i = 0; i < questions.length; i++) {
      clarification += `Question: ${questions[i]}\nAnswer: ${answers[i]}\n\n`;
    }

    // Prepare the request to Claude API with updated formatting instructions
    const prompt = `
You are writing a Decision Memo as an executive who values first-principles thinking, ownership, mission alignment, and truth-speaking.

The conversation context is:
${context}

${participants ? `The participants are: ${participants}` : ''}

Additional clarification:
${clarification}

Create a Decision Memo that answers these five questions:
1. What is the choice you made?
2. Why make this decision? What were the factors involved?
3. What are the risks of making this decision?
4. What is the compensation / reward for taking those risks?
5. What other choices were considered?

Begin with a concise title for the decision memo in the format:
# [Title of Decision]

For example:
# Renaming Product Indices

Then follow with these exact headings in Slack bold format (using asterisks):
*What is the choice you made?*
[Answer - be clear and concise about the decision made]

*Why make this decision? What were the factors involved?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

*What are the risks of making this decision?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

*What is the compensation / reward for taking those risks?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

*What other choices did you consider?*
[Use bullet points that start with a single asterisk immediately followed by text with no space in between]

IMPORTANT FORMATTING INSTRUCTIONS:
1. Each bullet point should begin with a single asterisk (*) immediately followed by text with no space in between.
2. Do not use nested formatting within bullet points - avoid using bold or other special formatting inside bullet points.
3. If you need to emphasize a point, use ALL CAPS for emphasis instead.
4. Keep all bullet points as single, continuous lines of text.

IMPORTANT STRUCTURE GUIDELINES:
1. Vary your approach to each section based on what's most relevant - some sections may need only 2-3 key points while others might require more depth.
2. Prioritize quality over quantity - it's better to have 3 insightful points than 6 superficial ones.
3. Consider the relative importance of each section for this particular decision - not all sections need equal detail.
4. For the most nuanced or complex points, consider using a brief paragraph instead of a bullet point when it would be clearer.
5. Make the memo feel organic and thoughtful rather than formulaic - avoid having exactly the same number of points in each section.

ADDITIONAL CONTENT INSTRUCTIONS:
1. Carefully incorporate insights from ALL the clarifying questions and answers, especially the final "anything else" question.
2. Pay special attention to any new information that was provided in response to the final question.
3. Make sure the decision memo reflects a complete understanding of the situation, including any nuances, concerns, or context added in the clarification phase.
4. Connect these additional insights to the strategic reasoning, risk assessment, and alternatives consideration.

Be concise but thorough in your content. Don't fabricate information, but do connect the decision to deeper strategic thinking where the connection is clear from the context.

DO NOT include the clarifying questions and answers in the memo.
`;

    // Call Claude API - Updated to use Claude 3.7 Sonnet
    console.log("Sending request to Claude API for memo with clarification...");
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      }
    });

    console.log("Received memo with clarification from Claude API");

    // Return the Decision Memo
    return response.data.content[0].text;
  } catch (error) {
    console.error('Error generating Decision Memo with clarification:', error);

    // If API fails, fall back to a generic template
    return `# Decision Memo

*What is the choice you made?*
Based on the conversation and clarification, a decision was made but I couldn't generate a specific memo due to a technical issue.

*Why make this decision? What were the factors involved?*
*Several factors were likely considered

*What are the risks of making this decision?*
*There may be various risks associated with this decision

*What is the compensation / reward for taking those risks?*
*There are likely benefits to balance the risks

*What other choices did you consider?*
*Alternative approaches were likely evaluated

Note: There was an error connecting to the AI service. Please try again later.`;
  }
}

// Create a simple home route
expressApp.get('/', (req, res) => {
  res.send('Decision Memo Slack Bot is running!');
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Decision Memo app is running!');

  // Environment variable check
  console.log('Environment check:');
  console.log('- SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'Set ✓' : 'Missing ✗');
  console.log('- SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'Set ✓' : 'Missing ✗');
  console.log('- SLACK_APP_TOKEN:', process.env.SLACK_APP_TOKEN ? 'Set ✓' : 'Missing ✗');
  console.log('- ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'Set ✓' : 'Missing ✗');
})();

// Listen for Express app
const PORT = process.env.PORT || 3001;
expressApp.listen(PORT, () => {
  console.log(`Express server is running on port ${PORT}`);
});