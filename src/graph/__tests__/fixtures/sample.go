// Package main is a sample Go file for testing the code-graph extractor.

package main

import (
	"fmt"
	"strings"
)

// User represents a user in the system.
type User struct {
	Name string
	Age  int
}

type Role string

const (
	RoleAdmin Role = "admin"
	RoleMember Role = "member"
)

var globalFlag = true

// Greeter is an interface for greeting.
type Greeter interface {
	Greet() string
}

func (u *User) Greet() string {
	return fmt.Sprintf("Hello, my name is %s", u.Name)
}

func processOrder(order *Order) {
	fmt.Println("Processing order:", order.ID)
}

type Order struct {
	ID   int
	Items []string
}

func (o *Order) AddItem(item string) {
	o.Items = append(o.Items, item)
}

type Box[T any] struct {
	Value T
}

func makeBox[T any](val T) Box[T] {
	return Box[T]{Value: val}
}

func consume(val any) {}

func CreateUser(name string) *User {
	u := &User{Name: name, Age: 30}
	processOrder(&Order{ID: 1})
	u.Greet()
	consume(makeBox(42))
	return u
}

type Repo[T any] interface {
	Get() T
}
