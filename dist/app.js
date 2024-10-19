"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const client_sqs_1 = require("@aws-sdk/client-sqs");
const fs_1 = __importDefault(require("fs"));
const client_ec2_1 = require("@aws-sdk/client-ec2");
const timers_1 = require("timers");
const app = (0, express_1.default)();
const port = 3000;
// AWS Configuration
const REGION = "us-east-1";
const ASU_ID = "1229855837"; // Replace with your ASU ID
const sqs = new client_sqs_1.SQSClient({ region: REGION });
const AMI_ID = "ami-093f92df1f9a9e364"; // Replace with your AMI ID
const MAX_INSTANCES = 20;
const MIN_INSTANCES = 1;
// Queue URLs
// https://sqs.us-east-1.amazonaws.com/137068238639/1229855837-req-queue.fifo
// const REQUEST_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ASU_ID}/${ASU_ID}-req-queue`;
// const RESPONSE_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ASU_ID}/${ASU_ID}-resp-queue`;
const REQUEST_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/137068238639/${ASU_ID}-req-queue.fifo`;
const RESPONSE_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/137068238639/${ASU_ID}-resp-queue.fifo`;
// Set up multer for handling file uploads
const upload = (0, multer_1.default)({ dest: "uploads/" });
const ec2 = new client_ec2_1.EC2Client({ region: REGION });
function getQueueLength() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        try {
            const command = new client_sqs_1.GetQueueAttributesCommand({
                QueueUrl: REQUEST_QUEUE_URL,
                AttributeNames: ["ApproximateNumberOfMessages"],
            });
            const response = yield sqs.send(command);
            return parseInt(((_a = response.Attributes) === null || _a === void 0 ? void 0 : _a.ApproximateNumberOfMessages) || "0", 10);
        }
        catch (error) {
            console.error("Error getting queue length:", error);
            return 0;
        }
    });
}
function getCurrentInstanceCount() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        try {
            const command = new client_ec2_1.DescribeInstancesCommand({
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
            const response = yield ec2.send(command);
            return ((_a = response.Reservations) === null || _a === void 0 ? void 0 : _a.length) || 0;
        }
        catch (error) {
            console.error("Error getting instance count:", error);
            return 0;
        }
    });
}
function launchAppTierInstance(instanceIndex) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const command = new client_ec2_1.RunInstancesCommand({
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
            });
            yield ec2.send(command);
            console.log(`Launched new App Tier instance: app-tier-instance-${instanceIndex}`);
        }
        catch (error) {
            console.error("Error launching new App Tier instance:", error);
        }
    });
}
function terminateAppTierInstance(instanceId) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const command = new client_ec2_1.TerminateInstancesCommand({
                InstanceIds: [instanceId],
            });
            yield ec2.send(command);
            console.log(`Terminated App Tier instance: ${instanceId}`);
        }
        catch (error) {
            console.error("Error terminating App Tier instance:", error);
        }
    });
}
function scaleAppTier() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        try {
            const queueLength = yield getQueueLength();
            console.log(queueLength);
            const currentInstanceCount = yield getCurrentInstanceCount();
            console.log(currentInstanceCount);
            console.log(`Queue length: ${queueLength}, Current instance count: ${currentInstanceCount}`);
            if (queueLength > 5 && currentInstanceCount < MAX_INSTANCES) {
                // Launch a new App Tier instance if the queue length exceeds 5 and max limit is not reached
                yield launchAppTierInstance(currentInstanceCount + 1);
            }
            else if (queueLength === 0 && currentInstanceCount > MIN_INSTANCES) {
                // Terminate an App Tier instance if there are no messages in the queue and more than minimum instances
                const command = new client_ec2_1.DescribeInstancesCommand({
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
                const response = yield ec2.send(command);
                const instanceId = (_d = (_c = (_b = (_a = response.Reservations) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.Instances) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.InstanceId;
                if (instanceId) {
                    yield terminateAppTierInstance(instanceId);
                }
            }
        }
        catch (error) {
            console.error("Error during autoscaling:", error);
        }
    });
}
// Endpoint to accept images from users
app.post("/", upload.single("inputFile"), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const file = req.file;
    if (!file) {
        res.status(400).send("No file uploaded.");
        return;
    }
    const fileName = file.originalname;
    const filePath = file.path;
    try {
        // Read the image and encode it as base64
        const fileBuffer = fs_1.default.readFileSync(filePath);
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
        yield sqs.send(new client_sqs_1.SendMessageCommand(message));
        console.log("Message sent to queue");
        // Poll the Response Queue for the classification result
        let result;
        const maxRetries = 100;
        for (let i = 0; i < maxRetries; i++) {
            const response = yield sqs.send(new client_sqs_1.ReceiveMessageCommand({
                QueueUrl: RESPONSE_QUEUE_URL,
                MaxNumberOfMessages: 1,
                WaitTimeSeconds: 20,
            }));
            if (response.Messages && response.Messages.length > 0) {
                const receivedMessage = response.Messages[0];
                const responseBody = JSON.parse(receivedMessage.Body || "{}");
                if (responseBody.fileName === fileName) {
                    result = responseBody.classificationResult;
                    // Delete the message from the Response Queue
                    yield sqs.send(new client_sqs_1.DeleteMessageCommand({
                        QueueUrl: RESPONSE_QUEUE_URL,
                        ReceiptHandle: receivedMessage.ReceiptHandle,
                    }));
                    break;
                }
            }
        }
        // Send the response back to the user
        if (result) {
            res.send(`${fileName}:${result}`);
            return;
        }
        else {
            res.status(500).send("Failed to get the classification result.");
        }
    }
    catch (error) {
        console.error("Error:", error);
        res.status(500).send("Error processing request.");
    }
    finally {
        // Clean up the uploaded file
        fs_1.default.unlinkSync(filePath);
    }
}));
// Start the web server
app.listen(port, () => {
    console.log(`Web tier listening at http://localhost:${port}`);
    (0, timers_1.setInterval)(scaleAppTier, 30000);
});
