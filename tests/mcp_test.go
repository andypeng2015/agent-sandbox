/*
 * Copyright 2025 The https://github.com/agent-sandbox/agent-sandbox Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package tests_test

//Test CreateRecorder
import (
	"fmt"
	"log"
	"testing"

	"context"

	"github.com/agent-sandbox/agent-sandbox/pkg/utils"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	kubeclient "knative.dev/pkg/client/injection/kube/client"
	"knative.dev/pkg/injection"
)

func getSession() *mcp.ClientSession {
	url := "http://localhost:10000/mcp"
	ctx := context.Background()

	// Create the URL for the server.
	log.Printf("Connecting to MCP server at %s", url)

	// Create an MCP client.
	client := mcp.NewClient(&mcp.Implementation{
		Name:    "mcp-client",
		Version: "1.0.0",
	}, nil)

	// Connect to the server.
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: url}, nil)
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}

	log.Printf("Connected to server (session ID: %s)", session.ID())

	// First, list available tools.
	log.Println("Listing available tools...")
	toolsResult, err := session.ListTools(ctx, nil)
	if err != nil {
		log.Fatalf("Failed to list tools: %v", err)
	}

	for _, tool := range toolsResult.Tools {
		log.Printf("  - %s: %s: %s\n", tool.Name, tool.Description, tool.InputSchema)
	}

	return session
}

func TestCreate(t *testing.T) {
	ctx := context.Background()
	session := getSession()

	// Call the tool.
	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "createSandbox",
		Arguments: map[string]any{
			"name": "sandbox-01",
		},
	})
	if err != nil {
		log.Printf("Error rise %v\n", err)
	}

	// Print the result.
	for _, content := range result.Content {
		if textContent, ok := content.(*mcp.TextContent); ok {
			log.Printf("  %s", textContent.Text)
		}
	}

	log.Println("Client completed successfully")
}

func TestList(t *testing.T) {
	ctx := context.Background()
	session := getSession()

	// Call the tool.
	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "listSandbox",
	})
	if err != nil {
		log.Printf("Error rise %v\n", err)
	}

	// Print the result.
	for _, content := range result.Content {
		if textContent, ok := content.(*mcp.TextContent); ok {
			log.Printf("  %s", textContent.Text)
		}
	}

	log.Println("Client completed successfully")
}

func TestGET(t *testing.T) {
	ctx := context.Background()
	session := getSession()

	// Call the tool.
	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "getSandbox",
		Arguments: map[string]any{
			"name": "sandbox-01",
		},
	})
	if err != nil {
		log.Printf("Error rise %v\n", err)
	}

	// Print the result.
	for _, content := range result.Content {
		if textContent, ok := content.(*mcp.TextContent); ok {
			log.Printf("  %s", textContent.Text)
		}
	}

	log.Println("Client completed successfully")
}

func TestExec(t *testing.T) {
	cmd := []string{
		"sh",
		"-c",
		fmt.Sprintf("curl -s -o /dev/null  http://127.0.0.1:%d/hello", 8080),
	}

	rootCtx, _ := context.WithCancel(context.Background())
	kubecfg := injection.ParseAndGetRESTConfigOrDie()

	rootCtx = injection.WithNamespaceScope(rootCtx, "ymcas")
	rootCtx, _ = injection.Default.SetupInformers(rootCtx, kubecfg)

	kubeClient := kubeclient.Get(rootCtx)

	stdout, stderr, err := utils.ExecCommand(kubeClient, kubecfg, "ymcas", "sbx-template-demo-f1523dbe531240af83bb-zhp9m", "sandbox", cmd)

	log.Println("exec result err: ", err)
	log.Println("exec result stderr: ", stderr)
	log.Println("exec result stdout: ", stdout)

}

func TestDEL(t *testing.T) {
	ctx := context.Background()
	session := getSession()

	// Call the tool.
	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "deleteSandbox",
		Arguments: map[string]any{
			"name": "sandbox-01",
		},
	})
	if err != nil {
		log.Printf("Error rise %v\n", err)
	}

	// Print the result.
	for _, content := range result.Content {
		if textContent, ok := content.(*mcp.TextContent); ok {
			log.Printf("  %s", textContent.Text)
		}
	}

	log.Println("Client completed successfully")
}
