package emailguard_test

import (
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/agentisend/agent-email-guard/go/storetest"
)

func TestMemoryStoreContract(t *testing.T) {
	storetest.Run(t, func(*testing.T) emailguard.Store { return emailguard.NewMemoryStore() })
}
