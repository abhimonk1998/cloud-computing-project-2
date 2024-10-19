# Use official Node.js image as the base image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json files to install dependencies
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the entire project to the working directory in the container
COPY . .

# Build the TypeScript files
RUN npm run build

# Expose port 3000 to the host (this is the port your app will listen on)
EXPOSE 3000

# Command to run the application
# CMD ["node", "dist/app.js"]
CMD ["npm", "start"]