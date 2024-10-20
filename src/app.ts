import express, { Request, Response } from "express";
import multer from "multer";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import fs from "fs";
import path from "path";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { setInterval } from "timers";

const app = express();
const port = 3000;

// AWS Configuration
const REGION = "us-east-1";
const ASU_ID = "1229855837"; // Replace with your ASU ID
const sqs = new SQSClient({ region: REGION });
const AMI_ID = "ami-0a047f27c26141696"; // Replace with your AMI ID
const MAX_INSTANCES = 20;
const MIN_INSTANCES = 1;

const userDataScript = `#!/bin/bash
    sudo docker run -d -e AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} -e AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} -e AWS_REGION=${process.env.AWS_REGION} abhimonk1998/app-tier:latest`;

// Queue URLs
// https://sqs.us-east-1.amazonaws.com/137068238639/1229855837-req-queue.fifo
// const REQUEST_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ASU_ID}/${ASU_ID}-req-queue`;
// const RESPONSE_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ASU_ID}/${ASU_ID}-resp-queue`;

const REQUEST_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/137068238639/${ASU_ID}-req-queue.fifo`;
const RESPONSE_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/137068238639/${ASU_ID}-resp-queue.fifo`;

// Set up multer for handling file uploads
const upload = multer({ dest: "uploads/" });

const ec2 = new EC2Client({ region: REGION });

async function getQueueLength(): Promise<number> {
  try {
    const command = new GetQueueAttributesCommand({
      QueueUrl: REQUEST_QUEUE_URL,
      AttributeNames: ["ApproximateNumberOfMessages"],
    });
    const response = await sqs.send(command);
    return parseInt(
      response.Attributes?.ApproximateNumberOfMessages || "0",
      10
    );
  } catch (error) {
    console.error("Error getting queue length:", error);
    return 0;
  }
}

async function getCurrentInstanceCount(): Promise<number> {
  try {
    const command = new DescribeInstancesCommand({
      Filters: [
        {
          Name: "tag:Name",
          Values: ["app-tier-instance-*"],
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
      ],
    });
    const response = await ec2.send(command);
    return response.Reservations?.length || 0;
  } catch (error) {
    console.error("Error getting instance count:", error);
    return 0;
  }
}

async function launchAppTierInstance(instanceIndex: number): Promise<void> {
  try {
    const command = new RunInstancesCommand({
      ImageId: AMI_ID,
      InstanceType: "t2.micro",
      MinCount: 1,
      MaxCount: 1,
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [{ Key: "Name", Value: `app-tier-instance-${instanceIndex}` }],
        },
      ],
      UserData: Buffer.from(userDataScript).toString("base64"),
    });
    await ec2.send(command);
    console.log(
      `Launched new App Tier instance: app-tier-instance-${instanceIndex}`
    );
  } catch (error) {
    console.error("Error launching new App Tier instance:", error);
  }
}

async function terminateAppTierInstance(instanceId: string): Promise<void> {
  try {
    const command = new TerminateInstancesCommand({
      InstanceIds: [instanceId],
    });
    await ec2.send(command);
    console.log(`Terminated App Tier instance: ${instanceId}`);
  } catch (error) {
    console.error("Error terminating App Tier instance:", error);
  }
}

async function scaleAppTier(): Promise<void> {
  try {
    const queueLength = await getQueueLength();
    console.log(queueLength);
    const currentInstanceCount = await getCurrentInstanceCount();
    console.log(currentInstanceCount);
    console.log(
      `Queue length: ${queueLength}, Current instance count: ${currentInstanceCount}`
    );

    if (queueLength > 5 && currentInstanceCount < MAX_INSTANCES) {
      // Launch a new App Tier instance if the queue length exceeds 5 and max limit is not reached
      await launchAppTierInstance(currentInstanceCount + 1);
    } else if (queueLength === 0 && currentInstanceCount > MIN_INSTANCES) {
      // Terminate an App Tier instance if there are no messages in the queue and more than minimum instances
      const command = new DescribeInstancesCommand({
        Filters: [
          {
            Name: "tag:Name",
            Values: ["app-tier-instance-*"],
          },
          {
            Name: "instance-state-name",
            Values: ["running"],
          },
        ],
      });
      const response = await ec2.send(command);
      const instanceId = response.Reservations?.[0]?.Instances?.[0]?.InstanceId;

      if (instanceId) {
        await terminateAppTierInstance(instanceId);
      }
    }
  } catch (error) {
    console.error("Error during autoscaling:", error);
  }
}
// Endpoint to accept images from users
app.post(
  "/",
  upload.single("inputFile"),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).send("No file uploaded.");
      return;
    }

    const fileName = file.originalname;
    const filePath = file.path;

    try {
      // Read the image and encode it as base64
      const fileBuffer = fs.readFileSync(filePath);
      const fileBase64 = fileBuffer.toString("base64");

      // Send a message to the Request Queue with the image data
      const message = {
        QueueUrl: REQUEST_QUEUE_URL,
        MessageBody: JSON.stringify({
          fileName,
          fileData: fileBase64,
        }),
        MessageGroupId: "app-tier-group", // REQUIRED for FIFO queue
        MessageDeduplicationId: fileName, // Ensures message uniqueness for deduplication
      };
      await sqs.send(new SendMessageCommand(message));
      console.log("Message sent to queue");
      // Poll the Response Queue for the classification result
      let result: string | undefined;
      const maxRetries = 100;
      while (true) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: RESPONSE_QUEUE_URL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 60,
          })
        );

        if (response.Messages && response.Messages.length > 0) {
          const receivedMessage = response.Messages[0];
          const responseBody = JSON.parse(receivedMessage.Body || "{}");

          if (responseBody.fileName === fileName) {
            result = responseBody.classificationResult;

            // Delete the message from the Response Queue
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: RESPONSE_QUEUE_URL,
                ReceiptHandle: receivedMessage.ReceiptHandle!,
              })
            );
            break;
          }
        }
      }

      // Send the response back to the user
      if (result) {
        res.send(`${fileName}:${result}`);
        return;
      } else {
        res.status(500).send("Failed to get the classification result.");
      }
    } catch (error) {
      console.error("Error:", error);
      res.status(500).send("Error processing request.");
    } finally {
      // Clean up the uploaded file
      fs.unlinkSync(filePath);
    }
  }
);

// Start the web server
app.listen(port, () => {
  console.log(`Web tier listening at http://localhost:${port}`);
  setInterval(scaleAppTier, 5000);
});
